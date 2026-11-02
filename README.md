# Verified Human Attention Market

[English](README.md) | [繁體中文](README.zh-TW.md)

Advertisers pay for attention from **verified unique humans**, and those humans are paid in **USDC**. Budgets sit in an on-chain escrow, World ID proves a participant is a unique person, and an off-chain verifier decides whether the work was actually done before the contract releases a reward.

> **This is not a "watch ads to earn crypto" site.** The goal is a market, and later an API, for buying human attention that can be verified, so that bots and farms cannot drain the budget.

> ⚠️ **Testnet only.** The contracts are not audited and the project has not passed its production-readiness gate ([#29](https://github.com/ChiJiun/verified-human-attention-market/issues/29)). Do not use real funds.

**New developer or AI session?** Start with [AGENTS.md](AGENTS.md).

---

## Status

| | |
| --- | --- |
| **Milestone** | M1 (proof of concept): the full flow ran on **Base Sepolia** on 2026-10-14. The run record is under review in [PR #62](https://github.com/ChiJiun/verified-human-attention-market/pull/62), and #12, #13 and #19 stay open until it is accepted |
| **What was proven** | A real World ID proof, an answered comprehension check, a backend-signed authorization and an on-chain USDC payout, followed by close and refund. Transactions are listed in [PR #62](https://github.com/ChiJiun/verified-human-attention-market/pull/62) |
| **Contract** | `CampaignManager` [`0x12cc9447CEb3f8E75dDf4463A1A4D9feB42bDFEc`](https://sepolia.basescan.org/address/0x12cc9447CEb3f8E75dDf4463A1A4D9feB42bDFEc) on Base Sepolia (chain `84532`) |
| **Next** | Close M1, then decide [ADR-0010](https://github.com/ChiJiun/verified-human-attention-market/pull/61): earn while browsing, with World ID at login and withdrawal |

Detailed status: [docs/SDLC_STATUS.md](docs/SDLC_STATUS.md).

---

## How it works

```mermaid
sequenceDiagram
    autonumber
    actor A as Advertiser
    actor U as Participant
    participant W as Web app
    participant API as API + indexer
    participant ID as World ID
    participant C as CampaignManager (Base)

    A->>W: Create campaign (content, reward, questions)
    W->>API: Save draft
    A->>C: createCampaign + fund (USDC escrow)
    C-->>API: Events, confirmed by the indexer → campaign "active"

    U->>W: Open mission link, connect wallet
    W->>API: Ask for a signed World ID request
    U->>ID: Prove unique human (World App)
    ID-->>API: Proof, verified by the backend
    U->>API: Submit answers
    API-->>U: EIP-712 claim authorization (signed off-chain)
    U->>C: claim(authorization)
    C-->>U: 1 USDC

    A->>C: closeCampaign, then refund after the waiting period
```

**Who decides what**

| Question | Decided by | Why there |
| --- | --- | --- |
| Is this a unique human? | World ID (zero-knowledge proof) | We never learn who the person is, only a per-campaign identifier that blocks a second claim |
| Did they actually engage? | API (off-chain verifier) | Rules change often and must stay private, such as the answer key |
| Is the payout valid? | Contract | Checks the signature, budget, completion cap, expiry and replay on-chain |
| How much was paid? | **The chain** | The database is reconciled from confirmed events, never the other way round |

**Safety rules built into the contract**

- **Budget conservation:** total payouts and refunds can never exceed what was funded.
- **No replay:** each authorization has a one-time nonce, and each wallet can claim once per campaign.
- **Delayed refund:** the advertiser can refund only after the last authorization that could have been issued has expired. An issued authorization therefore never races a refund, but the participant still has to claim it before it expires (at most 15 minutes).
- **Exposure limits:** reward, completions and budget per campaign are capped on-chain (POC: 1 USDC × 10).

---

## Architecture

```mermaid
flowchart LR
    subgraph Browser
        WEB["apps/web<br/>Next.js<br/>advertiser + mission pages"]
        WALLET[Wallet]
        WAPP[World App]
    end

    subgraph Server
        API["apps/api<br/>Fastify REST API"]
        IDX[Indexer worker]
        DB[(PostgreSQL)]
    end

    subgraph Base
        CM[CampaignManager]
        USDC[USDC]
    end

    WEB --> API
    WALLET -->|create, fund, claim| CM
    WAPP -->|proof| WEB
    API -->|verify proof| WID[World ID API]
    API --> DB
    IDX -->|read events| CM
    IDX --> DB
    CM --> USDC
```

| Package | What it is |
| --- | --- |
| [`apps/web`](apps/web) | Next.js app: advertiser dashboard (`/advertiser`) and participant mission page (`/mission?campaign=…`) with the World ID widget |
| [`apps/api`](apps/api) | Fastify API on PostgreSQL (Drizzle): campaigns, SIWE login, World ID verification, submissions, claim signing, moderation, analytics. Also runs the chain indexer and reconciliation worker |
| [`packages/contracts`](packages/contracts) | Solidity + Foundry: `CampaignManager` escrow with unit, fuzz and invariant tests, plus deployment scripts and records |
| [`packages/shared`](packages/shared) | Canonical contract ABI and chain configuration shared by the API and the web app |

Exact versions are in the package manifests and the lockfile.

---

## Run it locally

Requirements: Node.js 24+, pnpm 12.4.2, Foundry v1.8.4 (on Windows, inside WSL), Docker for PostgreSQL 16.

**Minimal start** (web + API only; sign-in, World ID and the chain stay disabled until configured):

```bash
pnpm install
docker run -d --name vham-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=vham postgres:16-alpine
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/vham
pnpm --filter @vham/api db:migrate
pnpm dev            # web on :3000, API on :3001
```

The API and indexer read settings only from environment variables, never from a `.env` file. [`.env.example`](.env.example) lists every variable. To keep them in a git-ignored `.env`, load it into the shell first: `set -a; source .env; set +a` (bash/zsh) or one `$env:NAME = "value"` line per variable (PowerShell).

**Full flow** (local chain, contract, indexer, wallet, simulated World ID): follow **[docs/DEMO.md](docs/DEMO.md)** (Traditional Chinese). It runs the real contract on anvil; only World ID is simulated.

Before every commit:

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm build && pnpm format:check
cd packages/contracts && forge fmt --check && forge build --sizes && forge test -vv
```

| Test layer | Command | Needs |
| --- | --- | --- |
| Unit + API (in memory) | `pnpm test` | nothing |
| PostgreSQL integration | `pnpm test` with `TEST_DATABASE_URL` set | PostgreSQL 16 |
| Contracts | `forge test -vv` in `packages/contracts` | Foundry |
| ABI drift | `forge build && node scripts/export-abi.mjs --check` in `packages/contracts` | Foundry |
| End-to-end on a local chain | `pnpm --filter @vham/api test:e2e` | anvil + PostgreSQL |

CI runs the `javascript`, `e2e` and `solidity` jobs on every push. Never commit keys or a filled-in `.env`. Testnet deployment: [docs/deployment/TESTNET.md](docs/deployment/TESTNET.md).

---

## Documentation map

| Document | Read it when you want to know… |
| --- | --- |
| [AGENTS.md](AGENTS.md) | The rules for working on this repo, what is done and what comes next |
| [docs/SDLC_STATUS.md](docs/SDLC_STATUS.md) | Where the project is right now |
| [docs/product/PRODUCT_BRIEF.md](docs/product/PRODUCT_BRIEF.md) | Who the product is for and why |
| [docs/product/REQUIREMENTS.md](docs/product/REQUIREMENTS.md) | What the MVP must do |
| [docs/product/VISION.md](docs/product/VISION.md) | The long-term vision, business model and full roadmap (formerly this README) |
| [docs/architecture/MVP_ARCHITECTURE.md](docs/architecture/MVP_ARCHITECTURE.md) | How the components fit together |
| [docs/architecture/CONTRACT_SPEC.md](docs/architecture/CONTRACT_SPEC.md) | Exactly what the contract does and guarantees |
| [docs/architecture/CLAIM_AUTHORIZATION.md](docs/architecture/CLAIM_AUTHORIZATION.md) | How the signed claim authorization works |
| [docs/architecture/API_SPEC.md](docs/architecture/API_SPEC.md) | Every API endpoint and error code |
| [docs/architecture/DATA_MODEL.md](docs/architecture/DATA_MODEL.md) | The database tables and their constraints |
| [docs/adr/](docs/adr/) | Why each major decision was made (see below) |
| [docs/threat-model/THREAT_MODEL.md](docs/threat-model/THREAT_MODEL.md) | What can go wrong and how it is mitigated |
| [docs/testing/TEST_PLAN.md](docs/testing/TEST_PLAN.md) | What is tested and how |
| [docs/privacy/DATA_RETENTION.md](docs/privacy/DATA_RETENTION.md) | What data is kept, for how long, and how it is deleted |
| [docs/operations/](docs/operations/) | Runbook, alerts, incidents, backups, moderation, production readiness |
| [docs/DEMO.md](docs/DEMO.md) | How to run the full flow, and the Base Sepolia run log |
| [docs/deployment/TESTNET.md](docs/deployment/TESTNET.md) | How to deploy to Base Sepolia |

### Architecture decisions (ADRs)

| ADR | Decision |
| --- | --- |
| [0001](docs/adr/0001-mvp-chain-base.md) | Base is the MVP chain; single chain first |
| [0002](docs/adr/0002-first-use-case-sponsored-content.md) | First mission: sponsored content + a short comprehension check |
| [0003](docs/adr/0003-poc-gas-ux.md) | In the POC the user pays testnet gas; revisit before real money |
| [0004](docs/adr/0004-claim-authorization-eip712.md) | Claims are authorized off-chain with EIP-712 and verified on-chain |
| [0005](docs/adr/0005-poc-campaign-economics.md) | POC economics: 1 test USDC × max 10, 0% fee |
| [0006](docs/adr/0006-onchain-exposure-limits.md) | Exposure limits enforced by the contract |
| [0007](docs/adr/0007-world-id-integration.md) | World ID via IDKit, one action per campaign, no raw identity stored |
| [0008](docs/adr/0008-signer-custody-and-payout-limits.md) | Claim-signer custody, admin roles and payout limits |
| [0009](docs/adr/0009-quality-signals-and-reputation-scope.md) | Campaign-scoped quality signals, no cross-campaign reputation yet |
| 0010 | *Proposed:* earn while browsing, World ID at login and withdrawal ([PR #61](https://github.com/ChiJiun/verified-human-attention-market/pull/61)) |

---

## Roadmap

| Milestone | Goal | Status |
| --- | --- | --- |
| M0 | Product decisions: first buyer, chain, gas, claim model, economics | ✅ Done |
| **M1** | **POC: the full money loop on a testnet** | 🟡 Ran on Base Sepolia; record and #12, #13, #19 under review |
| M2 | MVP for a real buyer: observability, privacy, moderation, signer custody | 🟡 Engineering baseline done; no real buyer yet |
| M3 | Closed beta: quality signals, public API, publisher SDK | 🟡 #25 and #26 done; #27 SDK open |
| M4 | AI agents buy campaigns over x402 | ⬜ Not started (#28) |
| M5 | Production readiness for real funds: audit, on-call | 🟡 Partial (#29) |
| M6–M7 | Publisher network, protocol ecosystem | ⬜ Not started |
| M8 | Multi-chain, only with evidence of demand | ⬜ Deferred (#30) |

Full roadmap with deliverables and exit criteria: [docs/product/VISION.md](docs/product/VISION.md#roadmap).

---

## Glossary

| Term | Meaning |
| --- | --- |
| **ADR** | Architecture Decision Record: a short document explaining one decision, the alternatives and the consequences. Status goes *Proposed → Accepted* |
| **M0–M8** | Milestones in the roadmap above |
| **P0–P3** | Issue priority: P0 must be done and blocks later work; P3 only after evidence of need |
| **EPIC** | A large issue that will be split into smaller ones |
| **World ID** | A zero-knowledge proof that someone is a unique human, without revealing who |
| **Nullifier** | The anonymous value World ID returns per app and action; the same person always gets the same one, which is how a second claim is blocked |
| **RP / RP signature** | Relying Party: our app. The backend signs every World ID request so nobody can impersonate it |
| **IDKit** | World's SDK; the widget shows the QR code the World App scans |
| **EIP-712** | A standard for signing structured data; the backend signs a claim authorization the contract can verify |
| **SIWE** | Sign-In with Ethereum: logging in by signing a message with the wallet |
| **Indexer** | A worker that reads confirmed contract events into the database, handling chain reorganizations |
| **Atomic units** | USDC has 6 decimals, so `1000000` means 1 USDC. Money is never stored as floating point |
| **Base Sepolia** | Base's public testnet (chain ID `84532`) |
| **anvil** | Foundry's local blockchain used for development and CI |
