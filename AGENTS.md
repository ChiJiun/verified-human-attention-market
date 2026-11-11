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

## 3. Current state

`docs/SDLC_STATUS.md` is the single status page (phases, ADR status, review gates); GitHub issues and CI are authoritative over both files. Implementation and testing are active, and the only deployment is the Base Sepolia testnet with no real funds. Do **not** restart planning from zero.

On 2026-11-02 (UTC, GitHub's `mergedAt`) the M1 review stack (#61–#63, #66, #68, #79, #81, #83–#85, #87, #88, #90, #92, #93) reached `main` through #94, which resolved the conflicts between those PRs. The same day #75, #76, #77, #78, #82, #86, #102 and #103 were fixed in #96–#107. On 2026-11-04 #109–#116 followed: the web app claims only on its configured chain and shows a claim as paid only with its `RewardClaimed` event, dependencies were patched (Next 16.4.5) with a CI audit job that also runs daily, the pages got DOM tests (#104), and review follow-ups were applied. #118 makes a submission before a campaign starts answer `CAMPAIGN_NOT_STARTED` again, a regression a local browser demo found. `docs/SDLC_STATUS.md` lists each PR. Next, in dependency order:

1. **Owner gate before the redeploy**: decide issue #80 (`CampaignManager` cleanup; a recommendation is in the issue), because the redeploy is the next on-chain change.
2. **Redeploy to Base Sepolia (ADR-0011)**: `createCampaign` takes a `draftRef`, so the 2026-10-14 contract is incompatible. Follow the migration steps in `docs/deployment/TESTNET.md` and the runbook `docs/deployment/BASE_SEPOLIA_RERUN.md`, deploy, and re-run the flow. The deploy needs the owner's keys and the World App scan needs the owner's phone. Then close M1 (#12, #13). #71 closes only after the #13 swap test passes as ADR-0007 describes.
3. **ADR-0010 (proposed only)**: passive accrual with World ID at login and withdrawal. Needs owner decisions and the #22 privacy review before any code.

Do not skip directly to multi-chain, x402, publisher SDK, or AARC.

`@worldcoin/idkit` 4.4.0 is a dependency of `apps/web`, and the web app gets `@worldcoin/idkit-core` 4.4.0 through it. Only `apps/api` declares `@worldcoin/idkit-core` directly, as a dev dependency: its tests check the signal hash against its `hashSignal` (`apps/api/test/world-id-signal.test.ts`, `apps/api/test/eligibility.test.ts`), and `world-id-signal.test.ts` also checks that this pin equals the version the web's IDKit resolves, so removing it breaks `pnpm test`. The API does not use it at runtime; RP signing is implemented with viem against the official vectors. `viem` is in both apps. Do not hand-roll keccak/secp256k1/EIP-712 signing.

`@vham/shared` is consumed from its build output (`packages/shared/dist`), built automatically by the root `postinstall`. After editing it (or regenerating the ABI) run `pnpm --filter @vham/shared build`.

---

## 4. Accepted architecture decisions

These ADRs are accepted unless a new ADR changes them. The files under `docs/adr/` are the decisions; the rules below are what code must not break.

| ADR | Rule |
| --- | --- |
| [0001](docs/adr/0001-mvp-chain-base.md) | Base, single chain first. Re-check official chain and token addresses right before deploying. |
| [0002](docs/adr/0002-first-use-case-sponsored-content.md) | First mission: sponsored content + short comprehension check, a baseline engagement test, not proof of deep attention. |
| [0003](docs/adr/0003-poc-gas-ux.md) | Participants pay testnet gas in the POC; sponsorship must be revisited before real money (#70). |
| [0004](docs/adr/0004-claim-authorization-eip712.md) | The off-chain verifier issues an EIP-712 `ClaimAuthorization`, which the contract verifies. |
| [0005](docs/adr/0005-poc-campaign-economics.md) | POC-only values: 1 test USDC per completion, max 10 completions, max 10 test USDC, 0% fee, 15 min–24 h duration. |
| [0006](docs/adr/0006-onchain-exposure-limits.md) | The three exposure limits are immutable `CampaignManager` constructor parameters. |
| [0007](docs/adr/0007-world-id-integration.md) | One World ID action per campaign, backend verification of 4.0 proofs only, HMAC participant keys, wallet-bound signal, RP-signed requests. |
| [0008](docs/adr/0008-signer-custody-and-payout-limits.md) | Signer custody (KMS behind a signing service in production), role separation, 24 h payout limit. |
| [0009](docs/adr/0009-quality-signals-and-reputation-scope.md) | Campaign-scoped quality flags only; no cross-campaign reputation without a new ADR. |
| [0011](docs/adr/0011-idempotent-campaign-creation.md) | Idempotent creation per draft (`draftRef`); deployments kept apart in the database; a reorg beyond the confirmation depth halts the deployment; acceptance and its authorization are one persisted result. |

[ADR-0010](docs/adr/0010-passive-accrual-verify-at-withdrawal.md) is **proposed only** and is not a decision.

The signed claim fields (ADR-0004, ADR-0011):

```text
ClaimAuthorization {
  campaignId
  draftRef
  claimant
  amount
  nonce
  issuedAt
  expiresAt
}
```

---

## 5. Non-negotiable MVP constraints

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

## 6. Repository structure

```text
.
├─ README.md
├─ README.zh-TW.md
├─ AGENTS.md
├─ CONTRIBUTING.md     # checks before a commit
├─ docs/
│  ├─ SDLC_STATUS.md   # status page
│  ├─ DEMO.md          # local and testnet run (DEMO.zh-TW.md: Traditional Chinese)
│  ├─ HACKATHON.md     # submission summary (HACKATHON.zh-TW.md: Traditional Chinese)
│  ├─ images/          # screenshots used by the README
│  ├─ adr/             # decisions; README.md is the index
│  ├─ architecture/
│  ├─ deployment/      # TESTNET.md, BASE_SEPOLIA_RERUN.md
│  ├─ operations/      # runbook, alerts, readiness, incidents
│  ├─ privacy/
│  ├─ product/
│  ├─ testing/
│  └─ threat-model/
├─ apps/
│  ├─ web/          # Next.js frontend
│  └─ api/          # Fastify + PostgreSQL/Drizzle API, indexer worker
├─ packages/
│  ├─ contracts/    # Solidity + Foundry, deployment records, ABI export
│  └─ shared/       # browser-safe types, canonical ABI, chain list, deployment/settlement/World ID signal helpers
├─ scripts/db/      # backup/restore drill
└─ .github/
   └─ workflows/
```

Package manifests and lockfiles are authoritative for exact dependency versions.

---

## 7. Local environment

Repository location on the current Windows machine:

```text
D:\Code\GitHub Desktop\verified-human-attention-market
```

Current baseline:

- Node.js 24+ (root `engines`: `>=24.0.0`). The web app's DOM tests run in jsdom 30, whose `engines` needs `^24.15.0` on the Node 24 line, so run `pnpm test` on Node 24.15 or newer.
- pnpm 12.4.2
- Foundry v1.8.4
- Solidity 0.8.30
- PostgreSQL 16 in CI

Foundry may be installed natively or, on Windows, in WSL. A machine may lack Foundry, PostgreSQL or anvil; CI is then the required check for what it cannot run locally: the `solidity` job for Foundry, the `javascript` job (with a PostgreSQL service) for the PostgreSQL integration tests, and the `e2e` job for the anvil run. Without a local database (`TEST_DATABASE_URL` unset) the PostgreSQL integration tests skip.

Do not install or upgrade major dependencies casually. If an upgrade changes architecture/runtime behavior, document it.

---

## 8. Required JavaScript/TypeScript checks

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

## 9. Required Solidity checks

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

## 10. Smart-contract safety rules

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

## 11. Financial/API coding rules

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

## 12. World ID / privacy rules

World ID integration is implemented (ADR-0007). On 2026-10-14 the v1 contract run on Base Sepolia verified a real production proof from an Orb-verified World App against a Developer Portal app (`docs/DEMO.md`). That run used the `proofOfHuman` preset, so its proof may have been a 3.0 proof. The 4.0-only request and the wallet-bound signal have not yet run against a real World App; the ADR-0011 re-run checks them (#13, #71, #74).

Before changing the World ID integration:

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

## 13. Database and persistence rules

Current database stack:

- PostgreSQL
- Drizzle ORM / Drizzle migrations

Current logical tables (see `docs/architecture/DATA_MODEL.md`):

- campaigns, missions
- eligibility, submissions, answers
- chain_events, reconciliation_state, indexer_halts
- auth_nonces, auth_sessions
- campaign_moderation, campaign_reports, moderation_actions
- api_clients

Do not modify production schema manually without a migration.

When schema changes:

1. update Drizzle schema;
2. generate migration;
3. inspect generated SQL;
4. run typecheck/tests;
5. ensure PostgreSQL CI passes.

Avoid storing free-form or unnecessary sensitive user data in the POC.

---

## 14. Current testing posture

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
- stateful budget/completion invariants;
- exposure limits (ADR-0006): reward / completions / budget above limit, boundaries, invalid constructor limits, fuzzed creation;
- cancel of an unfunded draft, no cancel once funded, no funding after end;
- signer rotation revokes old signatures; typehash pinned against the backend;
- draft reference (ADR-0011): duplicate / zero / other-advertiser reference, `CampaignCreated` carries it, funding for another draft, authorization for another draft, authorization after a deep reorg reusing an id;
- the `CampaignManager` reverts listed in #73 (not every revert has a test; `docs/SDLC_STATUS.md` names the ones without): wrong claim amount; authorization timing (not yet valid, lifetime too long, an inverted window that fails the time checks before the lifetime check, issued before start or after end); signature encoding (wrong length, high `s`, invalid `v`, and `v` of 0 or 1 accepted); wrong funding amount and funding twice; the `AlreadyFunded` and `InsufficientCampaignBudget` guards, which the public interface cannot reach, through a test harness that forces the state (#80 decides whether they stay); campaign window edges and fuzzed duration bounds and past starts;
- deployment script fail-fast checks and event/selector pins (`DeployCampaignManager.t.sol`, `EventTopics.t.sol`).

Do not reduce coverage when refactoring.

For every bug involving money or authorization, add a regression test before or with the fix.

---

## 15. Architecture-change rule

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

## 16. Git/GitHub workflow

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

## 17. Secret-handling rule

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

## 18. External-integration freshness rule

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

## 19. What a new session should do next

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

At this handoff, the expected next task is the owner-gated ADR-0011 redeploy and Base Sepolia re-run for #12/#13 (see §3), unless GitHub state shows that work has already advanced. It needs the owner's keys and phone, so prepare it but do not deploy.

---

## 20. Handoff prompt for a new ChatGPT session

The user can paste this:

> Open my `ChiJiun/verified-human-attention-market` repository with Devspace. Read `AGENTS.md` first, then `docs/SDLC_STATUS.md` and the relevant GitHub issues. Continue the current SDLC from the highest-priority unfinished M1 task. Do not restart architecture planning, do not weaken the existing contract/security invariants, run all required tests, commit and push completed work, verify CI, and update the issue/SDLC status.

