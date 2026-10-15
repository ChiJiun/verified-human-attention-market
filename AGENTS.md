# AGENTS.md

This file is the handoff entry point for any new ChatGPT, coding agent, or developer session working on this repository.

**Do not start by rewriting the architecture. Read the current decisions and continue the existing SDLC.**

---

## 1. Start here

Before modifying code, read these files in order:

1. `README.md` (or `README.zh-TW.md`)
2. `docs/SDLC_STATUS.md`
3. `docs/product/PRODUCT_BRIEF.md`
4. `docs/product/REQUIREMENTS.md`
5. `docs/architecture/MVP_ARCHITECTURE.md`
6. `docs/architecture/CONTRACT_SPEC.md`
7. `docs/architecture/CLAIM_AUTHORIZATION.md`
8. `docs/architecture/API_SPEC.md`
9. `docs/architecture/DATA_MODEL.md`
10. Relevant files under `docs/adr/`
11. `docs/threat-model/THREAT_MODEL.md`
12. `docs/testing/TEST_PLAN.md`
13. The relevant open GitHub issue before implementing a feature

Then inspect the current repository state:

```bash
git status
git log --oneline -5
gh issue list --state open
gh run list --limit 5
```

Do not assume this file is newer than the code. Git, GitHub issues, CI, and the implementation are the final source of truth.

---

## 2. Product thesis

The project is a **Verified Human Attention Market**.

It is not intended to become a simple "watch ads to earn crypto" site.

The core product idea is:

> Advertisers, creators, publishers, or AI agents can purchase verifiable human attention or human-in-the-loop work; verified humans receive USDC for completing meaningful tasks.

The long-term product may become **Verified Human Attention as an API**, but the current goal is a narrow POC/MVP.

---

## 3. Current SDLC state

Current phase:

```text
Planning         ✅ Complete
Requirements     ✅ Baseline complete
System Design    ✅ Baseline complete
Implementation  🟡 Active
Testing          🟡 Active
Deployment       ⬜ Not started
Operations       ⬜ Not started
```

The implementation is already underway. Do **not** restart planning from zero.

Completed implementation milestones include:

- monorepo scaffold;
- Next.js web app scaffold;
- Fastify API scaffold;
- PostgreSQL + Drizzle schema/migrations;
- campaign API baseline;
- API idempotency baseline;
- `CampaignManager` Solidity contract;
- EIP-712 claim verification on-chain;
- unit/fuzz/stateful invariant contract tests;
- JavaScript/TypeScript CI;
- Foundry CI;
- PostgreSQL service in CI.

Check `docs/SDLC_STATUS.md` and GitHub Issues for the latest state.

---

## 4. Current implementation order

Status as of 2026-10-13 (verify against GitHub, which is authoritative):

Done on `main`:

- #8 eligibility/submission persistence (one accepted completion per human, enforced in the DB)
- #18 on-chain exposure limits (ADR-0006)
- #15 mission model + deterministic engagement verifier
- #9 World ID eligibility, backend side (ADR-0007)
- `POST /v1/campaigns/:id/submissions` (eligibility + verifier + persistence, 2-attempt cap)
- #19 deployment script, canonical ABI export with CI drift check, fail-fast chain config, runtime ABI from `@vham/shared` in API and web (still open for the real testnet deployment record)
- #17 reorg-safe chain indexer; #16 verified on-chain linking + status sync; #20 analytics
- #10 EIP-712 claim authorization: live on-chain checks, cap = paid + unexpired outstanding, reissue of expired unredeemed authorizations
- #37 Sign-In with Ethereum; advertiser-only endpoints
- #13 (local part): `e2e` CI job runs the full economic loop on anvil, see `docs/DEMO.md`
- #11 advertiser web flow; #12 participant flow with simulated World ID on anvil
- M2: #21 observability, #22 privacy/retention, #24 moderation, #23 signer custody + payout limits (ADR-0008)
- M3 baseline: #26 API keys/rate limits/error model, #25 campaign-scoped quality signals (ADR-0009)
- #29 (partial): reconciliation, backup/restore drill, incident process — external security review and named on-call still open

Next, in dependency order:

1. **Redeploy to Base Sepolia (ADR-0011)**: `createCampaign` now takes a `draftRef`, so the 2026-10-14 contract is incompatible. The old record is already archived; follow the migration steps in TESTNET.md, deploy, and re-run the flow (World ID needs the owner's scan). Then close M1 (#12, #13, #19) after the owner's review; #13's RPC-timeout criterion is covered by the e2e job (lost response, concurrent resend, same-parameter campaign for another draft). Missing UX: close/refund buttons in the advertiser page.
2. **ADR-0010 (proposed, PR #61)** — passive accrual with World ID at login and withdrawal. Needs owner decisions and the #22 privacy review before any code.

`@worldcoin/idkit` 4.4.0 is in the web lockfile; `@worldcoin/idkit-core` is optional (RP signing is implemented with viem against the official vectors). `viem` is in both apps. Do not hand-roll keccak/secp256k1/EIP-712 signing.

`@vham/shared` is consumed from its build output (`packages/shared/dist`), built automatically by the root `postinstall`. After editing it (or regenerating the ABI) run `pnpm --filter @vham/shared build`.

Do not skip directly to multi-chain, x402, publisher SDK, or AARC.

---

## 5. Accepted architecture decisions

The following ADRs are already accepted unless a new ADR explicitly changes them.

### ADR-0001 — MVP chain

- **Base** is the working POC/MVP chain.
- Single-chain first.
- Re-check official chain/testnet addresses immediately before deployment.

### ADR-0002 — First mission

First mission:

> Sponsored content + short comprehension check

This is a baseline engagement test, not a claim that comprehension questions prove deep attention.

### ADR-0003 — POC gas UX

- User pays testnet gas in the first POC.
- Sponsored gas / paymaster must be reconsidered before real-money MVP.

### ADR-0004 — Claim authorization

- Off-chain verifier issues **EIP-712 typed-data authorization**.
- Contract verifies the authorization.
- Claim fields are:

```text
ClaimAuthorization {
  campaignId
  claimant
  amount
  nonce
  issuedAt
  expiresAt
}
```

### ADR-0005 — POC economics

POC-only values:

```text
1 test USDC per valid completion
max 10 completions
max 10 test USDC funding
0% protocol fee
15 min–24 h campaign duration
```

These are test parameters, not final pricing.

---

## 6. Non-negotiable MVP constraints

Do not add these to the critical path without explicit product/architecture review:

- native token;
- DAO;
- speculative tokenomics;
- multi-chain settlement;
- bridge logic;
- AARC;
- x402 user-reward transport;
- complex ML fraud scoring;
- fully decentralized engagement verification;
- large permissionless publisher marketplace.

Current intent:

- **USDC** = settlement asset;
- **World ID** = human-uniqueness / anti-Sybil layer;
- **engagement verifier** = separate from Proof of Human;
- **x402** = later Agent/API payment mechanism;
- **AARC** = later chain-abstraction candidate only if real multi-chain demand appears.

---

## 7. Repository structure

```text
.
├─ README.md
├─ README.zh-TW.md
├─ AGENTS.md
├─ docs/
│  ├─ SDLC_STATUS.md
│  ├─ adr/
│  ├─ architecture/
│  ├─ product/
│  ├─ testing/
│  └─ threat-model/
├─ apps/
│  ├─ web/          # Next.js frontend
│  └─ api/          # Fastify + PostgreSQL/Drizzle API
├─ packages/
│  ├─ contracts/    # Solidity + Foundry
│  └─ shared/       # shared TypeScript schemas/types
└─ .github/
   └─ workflows/
```

Package manifests and lockfiles are authoritative for exact dependency versions.

---

## 8. Local environment

Repository location on the current Windows machine:

```text
D:\Code\GitHub Desktop\verified-human-attention-market
```

Current baseline:

- Node.js 24+
- pnpm 12.4.2
- Foundry v1.8.4
- Solidity 0.8.30
- PostgreSQL 16 in CI
- Foundry is currently invoked via WSL on Windows

If Docker Desktop is not running locally, PostgreSQL integration tests may skip locally. GitHub Actions runs PostgreSQL as a service, so CI is the required integration check.

Do not install or upgrade major dependencies casually. If an upgrade changes architecture/runtime behavior, document it.

---

## 9. Required JavaScript/TypeScript checks

Before committing JavaScript/TypeScript changes, run:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm format:check
```

All must pass.

If database integration was changed, ensure the CI PostgreSQL integration test also passes.

---

## 10. Required Solidity checks

On Windows/WSL:

```bash
cd packages/contracts
forge fmt --check
forge build --sizes
forge test -vv
```

All must pass before pushing contract changes.

The CI pipeline also runs Foundry checks.

---

## 11. Smart-contract safety rules

`CampaignManager` is the financial core. Treat changes as security-sensitive.

Do not weaken these properties:

### Budget conservation

Paid rewards/refunds must never exceed campaign funding.

Current stateful invariant tests enforce budget conservation.

### Replay protection

- EIP-712 authorization nonce must not be reusable.
- One-wallet-per-campaign protection currently exists for the first mission.
- Do not remove replay checks without a replacement and tests.

### EIP-712 domain separation

The signature must remain bound to:

- contract/domain name/version;
- chain ID;
- verifying contract.

Do not replace EIP-712 with ad-hoc string signatures.

### Claim timing

The authorization includes both:

- `issuedAt`
- `expiresAt`

The contract enforces a maximum authorization TTL.

### Refund race protection

This is a deliberate design and must be preserved.

A backend authorization can exist off-chain before being submitted on-chain. Therefore the advertiser cannot immediately refund unused funds at close.

Refund is delayed until:

```text
issuance deadline + MAX_AUTHORIZATION_TTL
```

This ensures all honestly issued pre-close claim authorizations have expired before unused funds are returned.

If changing claim/refund semantics, add/update an ADR and tests.

### Token scope

POC/MVP supports one configured USDC-like token.

Do not add arbitrary ERC-20 reward tokens without separate security analysis.

### Upgradeability

No proxy upgradeability in the POC.

---

## 12. Financial/API coding rules

### Never use floating point for money

Use USDC atomic-unit strings or integer-compatible database fields.

Example:

```json
{
  "rewardPerCompletion": "1000000"
}
```

Do not use:

```json
{
  "rewardPerCompletion": 1.0
}
```

### Idempotency is mandatory for durable mutations

Current campaign creation requires:

```http
Idempotency-Key: ...
```

Same key + same normalized request:

- return original resource;
- do not create duplicate state.

Same key + different request:

- return conflict.

Extend the same principle to submissions/financially meaningful mutations.

### Chain is authoritative for settlement

The database is not the ultimate source of truth for:

- funded amount;
- claimed amount;
- refund amount;
- final settlement events.

The backend must reconcile from chain events.

### RPC timeout is not definitive transaction failure

If a transaction was broadcast and the RPC times out, reconcile by transaction hash / nonce / indexed event state.

---

## 13. World ID / privacy rules

World ID integration is implemented (ADR-0007) but has not yet been exercised against a real World App / Developer Portal app.

Before implementing it:

1. open current official World docs;
2. confirm the current API/SDK flow;
3. confirm current verification semantics;
4. update code/docs if the integration model has changed.

Do not expose or log raw proof payloads by default.

Do not create a public identity graph linking:

- World ID-related identifiers;
- wallet address;
- complete behavior history.

Store only the minimum campaign-specific identifier necessary for duplicate prevention.

Proof of Human is **not** Proof of Engagement.

A verified human can still farm rewards or submit low-quality work.

---

## 14. Database and persistence rules

Current database stack:

- PostgreSQL
- Drizzle ORM / Drizzle migrations

Current logical tables include:

- campaigns
- eligibility
- submissions
- answers
- chain_events
- reconciliation_state

Do not modify production schema manually without a migration.

When schema changes:

1. update Drizzle schema;
2. generate migration;
3. inspect generated SQL;
4. run typecheck/tests;
5. ensure PostgreSQL CI passes.

Avoid storing free-form or unnecessary sensitive user data in the POC.

---

## 15. Current testing posture

Current contract tests cover:

- create/fund/claim;
- invalid signer;
- wrong claimant;
- expired authorization;
- duplicate nonce;
- duplicate wallet claim;
- completion limit;
- unauthorized refund;
- refund grace period;
- pre-close authorization after close;
- post-close authorization rejection;
- pause behavior;
- funding fuzzing;
- stateful budget/completion invariants.

Do not reduce coverage when refactoring.

For every bug involving money or authorization, add a regression test before or with the fix.

---

## 16. Architecture-change rule

If a change materially affects any of these:

- chain choice;
- settlement asset;
- claim trust model;
- gas sponsorship;
- campaign economics;
- identity model;
- contract upgradeability;
- multi-chain architecture;
- x402 role;
- AARC role;

create or update an ADR under `docs/adr/`.

Do not silently change architecture only in code.

---

## 17. Git/GitHub workflow

Before editing:

```bash
git status
git pull --ff-only
```

Before commit:

```bash
git diff --check
```

Then run all relevant checks.

Use descriptive commits such as:

```text
feat: implement World ID eligibility verification
feat: add EIP-712 claim authorization service
test: add submission idempotency regression coverage
docs: update SDLC status after M1 API completion
```

After pushing:

1. verify GitHub Actions;
2. close the GitHub issue only if acceptance criteria are actually satisfied;
3. update `docs/SDLC_STATUS.md` when project phase/status materially changes.

Do not claim an issue is complete merely because code exists locally.

---

## 18. Secret-handling rule

Never commit:

- private keys;
- World ID/API secrets;
- RPC credentials;
- database passwords used outside local examples;
- production wallet seed phrases;
- signing keys.

Use environment variables.

`.env.example` may contain variable names and safe placeholder/example values only.

---

## 19. External-integration freshness rule

External Web3 infrastructure changes quickly.

Before implementing or deploying anything involving:

- World ID;
- Base / Base Sepolia;
- USDC addresses;
- x402;
- AARC;
- wallet/account abstraction;
- paymasters;

re-check the current official documentation.

Do not trust an old chat summary or old README line for a current contract address or SDK method.

Document the date/source when an external integration choice materially affects architecture.

---

## 20. What a new session should do next

A new session should **not** ask the user to restate the entire project.

Use this workflow:

1. Read this file and the files in Section 1.
2. Check `git status`, latest commits, open issues, and CI.
3. Continue the highest-priority open M1 issue.
4. Preserve accepted ADRs and security invariants.
5. Run tests.
6. Commit/push.
7. Verify CI.
8. Update SDLC status / close issue only when acceptance criteria are met.

At this handoff, the expected next task is the **#12 remainder** (real World ID), then #19/#13 on Base Sepolia (see §4), unless GitHub state shows that work has already advanced.

---

## 21. Handoff prompt for a new ChatGPT session

The user can paste this:

> Open my `ChiJiun/verified-human-attention-market` repository with Devspace. Read `AGENTS.md` first, then `docs/SDLC_STATUS.md` and the relevant GitHub issues. Continue the current SDLC from the highest-priority unfinished M1 task. Do not restart architecture planning, do not weaken the existing contract/security invariants, run all required tests, commit and push completed work, verify CI, and update the issue/SDLC status.

