# Verified Human Attention Market

[English](README.md) | [繁體中文](README.zh-TW.md)

[![CI](https://github.com/ChiJiun/verified-human-attention-market/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ChiJiun/verified-human-attention-market/actions/workflows/ci.yml)

A proof of concept in which advertisers pay for attention from **verified unique humans**, and those humans are paid in **USDC**. Budgets sit in an on-chain escrow, World ID proves a participant is a unique person, and an off-chain verifier decides whether the work was actually done before the contract releases a reward.

> **This is not a "watch ads to earn crypto" site.** The goal is a market, and later an API, for buying human attention that can be verified, so that one bot or one person with many wallets cannot claim a campaign's budget many times over.

Today the engagement check is a short comprehension quiz: a baseline signal, not proof of deep attention ([ADR-0002](docs/adr/0002-first-use-case-sponsored-content.md)). A verified human can still farm rewards; World ID limits each person to one reward per campaign.

> ⚠️ **Testnet only.** The contracts are not audited and the project has not passed its production-readiness gate ([#29](https://github.com/ChiJiun/verified-human-attention-market/issues/29)). Do not use real funds.

**Reviewing this project?** [What is real today](#what-is-real-today) says what is proven and what is not, and [Run it locally](#run-it-locally) checks it in two commands. A short description for a submission form is in [docs/HACKATHON.md](docs/HACKATHON.md).

### Proof it runs

- **On a public testnet.** The full flow ran on Base Sepolia on 2026-10-14 (v1 contract) with a real World ID proof from an Orb-verified World App: [fund 3 USDC](https://sepolia.basescan.org/tx/0xda1673ced0c7b3c6bf6345d34339e49d86b33060f903168df53571508a3bea65) · [claim 1 USDC](https://sepolia.basescan.org/tx/0xc929552ca98dc923a18baf04b4d2c47b0b05b1c91093444eafa77a854bf876d7) · [refund 2 USDC](https://sepolia.basescan.org/tx/0x242c6aac019183f29a18c12e39ba2380a94ad2e9f4bf573662831da41c5e44a4) · [contract](https://sepolia.basescan.org/address/0x12cc9447CEb3f8E75dDf4463A1A4D9feB42bDFEc) · [all six transactions](docs/DEMO.md#the-base-sepolia-run-of-2026-10-14)
- **In CI, on every push and pull request.** The Foundry suite (60 tests as `forge` reports them, with three stateful invariants checked over 8,192 calls per run); more than 860 TypeScript tests; and an end-to-end run of the whole money loop on a local chain with PostgreSQL.
- **What that does not cover.** The testnet run used the earlier World ID request, which also allowed 3.0 proofs, and the contract has changed since. The current contract has run only on a local chain and in CI, where World ID is simulated. The current 4.0-only, wallet-bound request is covered only by unit tests against a mocked World API, not by a real World App. The testnet re-run is pending.

---

## What it looks like

Screenshots from a local run: local chain (anvil), simulated World ID, mock USDC.

| Advertiser: the campaign is funded and active | Participant: read and answer |
| --- | --- |
| ![Advertiser page: an active campaign with 10 USDC funded, 2 USDC paid for 2 completions, one of them flagged FAST_COMPLETION, and the participant link](docs/images/advertiser-active.png) | ![Mission page: the participant's wallet, a link to the sponsored content, one comprehension question and the Submit answers button](docs/images/mission-answer.png) |
| **Participant: the reward is paid on-chain** | **Advertiser: closed, refunded and settled** |
| ![Mission page: "Reward paid to your wallet" with the claim transaction hash](docs/images/mission-paid.png) | ![Advertiser page: the campaign is settled, 2 USDC paid, 0 USDC remaining, and the refund transaction is done](docs/images/advertiser-settled.png) |

---

## Why it exists

**Problem.** Campaigns pay for clicks and wallet activity that bots, or one person with many wallets, can produce. A wallet is not a unique human, and a unique human has not necessarily engaged.

**Who it is for.** First, an advertiser or creator who wants a small number of real people to read something. Publishers and AI agents buying through an API come later and are not built.

**Why World ID.** It gives an anonymous per-campaign identifier, so one person is paid once per campaign without the project learning who they are.

**Why on-chain.** The advertiser does not hand the budget to the platform. It sits in a contract that cannot pay more than was funded, pays only against a signed authorization, and returns the rest. What is still trusted: the off-chain verifier and its signing key, and the contract's owner. The owner can pause the contract (creating, funding, claiming and refunding) and replace the signer, so the owner is inside the same trust boundary as the signing key. No function lets the owner withdraw the escrow. The contract caps the loss (in the proof of concept, 10 test USDC per campaign).

| | Watch-to-earn, quest and survey platforms (typically) | This project |
| --- | --- | --- |
| Who can be paid | Often any account or wallet, so one person can run many | One World ID-verified human per campaign; a second wallet does not get a second reward |
| What is paid for | Often an impression, a click or an on-chain action | A completion the verifier accepted (today a comprehension check: a baseline, not proof of deep attention) |
| Paid in | Often the platform's own token or points | USDC; no native token, by design |
| Where the budget sits | Usually with the platform | In a per-campaign on-chain escrow; the advertiser takes back what was not spent |
| What is stored about the person | Often an account profile | For identity: a per-campaign keyed hash of the World ID nullifier and the claiming wallet; no name, no raw World ID data. Also the answers (deleted 30 days after the campaign ends) and the quality flags of a submission ([retention](docs/privacy/DATA_RETENTION.md)) |

The middle column describes categories of product, not any one of them.

---

## What is real today

| | Status |
| --- | --- |
| Escrow contract (`CampaignManager`, Solidity) | Built and tested. The v1 contract ran the full flow on Base Sepolia on 2026-10-14 (links above) |
| World ID | Real in that run: a production proof from an Orb-verified World App, verified by the backend. Simulated in the local demo and in CI. The current request (4.0 proofs only, bound to the claiming wallet) has not run against a real World App yet |
| USDC | Circle's test USDC on Base Sepolia; a mock token on the local chain |
| Web app, API, indexer | Built: the advertiser creates, funds, closes and refunds a campaign; the participant verifies, answers and claims |
| Not done yet | The contract changed after the testnet run (campaign creation became idempotent, [ADR-0011](docs/adr/0011-idempotent-campaign-creation.md)), so the current code is tested on a local chain and in CI and has not been redeployed to Base Sepolia. No audit, no mainnet, no real funds, no real advertiser |

Engineering status and the list of merged changes: [docs/SDLC_STATUS.md](docs/SDLC_STATUS.md).

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

## Engineering highlights

- **No refund race.** A claim authorization is signed off-chain, so one can exist that the chain has not seen. If the advertiser could refund at close, a participant holding a valid signature could find the escrow empty. The contract makes the advertiser wait until every authorization that could have been issued has expired ([`refundUnusedBudget`](packages/contracts/src/CampaignManager.sol#L319), `MAX_AUTHORIZATION_TTL` = 15 minutes).
- **A retry cannot create a second escrow.** A lost RPC response, a resend or a second browser tab cannot create a second campaign for the same draft: `createCampaign` is idempotent per draft, and the claim signature is bound to the same draft ([ADR-0011](docs/adr/0011-idempotent-campaign-creation.md)).
- **The chain is the ledger.** The database is reconciled from confirmed events by an indexer that handles reorganizations. A reorganization deeper than the confirmation depth stops signing instead of guessing.
- **The proof is requested for one wallet.** The World ID signal commits to the campaign and the claimant address, and the API refuses a result whose signal does not match before it asks World ([ADR-0007](docs/adr/0007-world-id-integration.md)). Tested locally and in CI. Whether World's verifier rejects a proof moved to another wallet has not been tested against a real World App yet ([#71](https://github.com/ChiJiun/verified-human-attention-market/issues/71)).
- **A small contract with no dependencies.** 443 lines and no imports. Unit, fuzz and invariant tests cover 93% of its lines and 71% of its branches (`forge coverage`, 2026-11-11). Three stateful invariants (budget conservation, payouts never exceed funding, completion cap) hold over 8,192 randomized calls per CI run.

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

Requirements: Node.js 24.15 or newer, pnpm 12.4.2, Foundry v1.8.4 (on Windows, inside WSL). Steps 2 and 3 also need PostgreSQL 16 or newer reachable through a connection URL. Docker is the quickest way; a native install works too. If port 5432 is taken, map another port and change the URL.

On Windows, run `forge` and `anvil` in WSL and the `pnpm` commands in PowerShell. Windows PowerShell 5.1 has no `&&`, so run chained commands one at a time, and write `$env:NAME = "value"` in place of `export NAME=value`.

**1. Check it in two commands** (no database, no chain)

```bash
pnpm install && pnpm test                  # API, web app and shared package
(cd packages/contracts && forge test -vv)  # the contract; it has no dependencies, so no `forge install`
```

Without a database `pnpm test` runs about 780 tests and skips the PostgreSQL integration tests. CI runs those too, which gives the 860+ above.

**2. The whole money loop on a local chain** (a few minutes)

The real contract on anvil, a real PostgreSQL database and the real API; only World ID is simulated. One test creates and funds a campaign, verifies a participant, pays a claim, has a second claim refused, closes, refunds, and then checks the API's figures against the chain. The same test also pays a second participant after the close and runs failure drills ([details](docs/DEMO.md#scripted-demo-the-end-to-end-test)).

```bash
# terminal 1
docker run --rm --name vham-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=vham_e2e postgres:16-alpine
# terminal 2
anvil
# terminal 3
pnpm install                      # if you skipped step 1
(cd packages/contracts && forge build)
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/vham_e2e
pnpm --filter @vham/api test:e2e
```

Expected: `Test Files  1 passed (1)`. If the test is reported as skipped, `TEST_DATABASE_URL` is not set. Point it at a database kept for this, because the run empties its tables. The same test is the `e2e` job in CI.

**3. Click through it in a browser**

The advertiser funds a campaign and the participant claims: follow [docs/DEMO.md](docs/DEMO.md). It needs six terminals and a browser wallet, and World ID is simulated.

The API and the indexer read their settings only from environment variables, never from a `.env` file. [`.env.example`](.env.example) lists every runtime variable. Never commit keys or a filled-in `.env`.

CI runs four jobs on every push and pull request: `javascript` (with PostgreSQL), `audit`, `e2e` and `solidity`. Contributors and AI coding agents: see [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

---

## Documentation

| Document | Read it when you want to know… |
| --- | --- |
| [docs/HACKATHON.md](docs/HACKATHON.md) | A short description of the project for a submission form |
| [docs/DEMO.md](docs/DEMO.md) | How to run the full flow, and the Base Sepolia run log |
| [docs/SDLC_STATUS.md](docs/SDLC_STATUS.md) | Where the project is right now, and which changes were merged when |
| [docs/product/PRODUCT_BRIEF.md](docs/product/PRODUCT_BRIEF.md) | Who the product is for and why (English and Chinese mixed) |
| [docs/product/VISION.md](docs/product/VISION.md) | The long-term vision, business model options and full roadmap |
| [docs/architecture/MVP_ARCHITECTURE.md](docs/architecture/MVP_ARCHITECTURE.md) | How the components fit together |
| [docs/architecture/CONTRACT_SPEC.md](docs/architecture/CONTRACT_SPEC.md) | Exactly what the contract does and guarantees |
| [docs/architecture/CLAIM_AUTHORIZATION.md](docs/architecture/CLAIM_AUTHORIZATION.md) | How the signed claim authorization works |
| [docs/threat-model/THREAT_MODEL.md](docs/threat-model/THREAT_MODEL.md) | What can go wrong and how it is mitigated (a few passages in Chinese) |
| [docs/adr/](docs/adr/README.md) | Why each major decision was made |
| [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) | The checks to run before a commit, and the rules for working on this repository |

More: [requirements](docs/product/REQUIREMENTS.md) (English and Chinese mixed), [API specification](docs/architecture/API_SPEC.md), [data model](docs/architecture/DATA_MODEL.md), [test plan](docs/testing/TEST_PLAN.md), [data retention](docs/privacy/DATA_RETENTION.md), [operations](docs/operations/) and [testnet deployment](docs/deployment/TESTNET.md).

---

## Roadmap

| Milestone | Goal | Status |
| --- | --- | --- |
| M0 | Product decisions: first buyer, chain, gas, claim model, economics | ✅ Done |
| **M1** | **POC: the full money loop on a testnet** | 🟡 Ran on Base Sepolia (v1 contract); the re-run on the updated contract is pending |
| M2 | MVP for a real buyer: observability, privacy, moderation, signer custody | 🟡 Engineering baseline done; no real buyer yet |
| M3 | Closed beta: quality signals, public API, publisher SDK | 🟡 Quality signals and the public API contract done; publisher SDK not started |
| M4 | AI agents buy campaigns over x402 | ⬜ Not started |
| M5 | Production readiness for real funds: audit, on-call | 🟡 Partial: no audit and no on-call yet |
| M6–M7 | Publisher network, protocol ecosystem | ⬜ Not started |
| M8 | Multi-chain, only with evidence of demand | ⬜ Deferred |

Business model: not implemented, and the proof of concept charges no fee ([ADR-0005](docs/adr/0005-poc-campaign-economics.md)). The options under consideration start with a percentage fee on settled campaign value or a fee per verified completion: [VISION §13](docs/product/VISION.md#13-business-model).

Full roadmap with deliverables and exit criteria: [docs/product/VISION.md](docs/product/VISION.md#roadmap).

---

## Glossary

| Term | Meaning |
| --- | --- |
| **World ID** | A zero-knowledge proof that someone is a unique human, without revealing who |
| **Nullifier** | The anonymous value World ID returns per app and action; the same person always gets the same one, which is how a second claim is blocked |
| **RP / RP signature** | Relying Party: our app. The backend signs every World ID request so nobody can impersonate it |
| **IDKit** | World's SDK; the widget shows the QR code the World App scans |
| **EIP-712** | A standard for signing structured data; the backend signs a claim authorization the contract can verify |
| **SIWE** | Sign-In with Ethereum: logging in by signing a message with the wallet |
| **Indexer** | A worker that reads confirmed contract events into the database, handling chain reorganizations |
| **ADR** | Architecture Decision Record: a short document explaining one decision, the alternatives and the consequences |
| **P0–P3** | Issue priority in issue titles: P0 must be done and blocks later work; P3 only after evidence of need |
| **EPIC** | A large issue that will be split into smaller ones |
| **Atomic units** | USDC has 6 decimals, so `1000000` means 1 USDC. Money is never stored as floating point |
| **Base Sepolia** | Base's public testnet (chain ID `84532`) |
| **anvil** | Foundry's local blockchain used for development and CI |
