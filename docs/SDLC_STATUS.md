# SDLC Status / 軟體開發生命週期狀態

> Last reviewed: 2026-11-11 (UTC). Merge dates on this page are GitHub's `mergedAt`, in UTC.

Milestone 0 的 working decisions 與 System Design baseline 已收斂，目前正式進入 **Implementation**。本文件是 SDLC 執行狀態頁；README 的 roadmap 則追蹤產品成熟度。

## Current Phase

```
Planning        ✅ Complete
Requirements    ✅ Baseline complete
System Design   ✅ Baseline complete
Implementation 🟡 Active
Testing        🟡 Active
Deployment     🟡 Base Sepolia testnet only; v1 run done 2026-10-14, ADR-0011 redeploy pending; no real funds
Operations     ⬜ Not started
```

## Working Product Decision

目前採用以下 **可逆的 working assumptions**，避免因輕微未決事項阻塞開發。正式進入 Implementation 前仍可由專案 owner 修改。

| Decision | Working choice | Status |
| --- | --- | --- |
| First buyer | Advertiser / creator | Working assumption |
| First mission | Sponsored article/content + short comprehension check | Working assumption |
| Settlement | USDC | Working assumption |
| MVP chain | Base | Accepted in ADR-0001 |
| Identity | World ID external integration | Accepted baseline |
| Proof of engagement | Off-chain verifier + EIP-712 claim authorization | Accepted in ADR-0004 |
| POC gas UX | User pays testnet gas | Accepted in ADR-0003 |
| POC economics | 1 test USDC × max 10, 0% fee | Accepted in ADR-0005 |
| Agent payment | x402, later milestone | Deferred |
| Multi-chain | None in MVP | Accepted principle |
| AARC | Only after multi-chain decision gate | Deferred |
| Native token | None | Out of scope |

## Why Base is the current default

As of 2026-10-05:

- Circle lists **Base** and **World Chain** among networks with native USDC support.
- World documentation supports **external integrations**, so the website does not have to live on World Chain merely to use World ID.
- x402 v2 supports EVM networks, and the reference specification includes Base Sepolia (`eip155:84532`) examples.

This makes Base a practical POC/MVP default while keeping World Chain as a credible alternative.

Official references:

- World Developer Docs: https://docs.world.org/
- World API reference: https://docs.world.org/reference/api
- Circle USDC: https://www.circle.com/usdc
- x402 protocol: https://github.com/x402-foundation/x402

## SDLC Artifacts

| Artifact | Status |
| --- | --- |
| Product Brief | ✅ Drafted |
| Requirements | ✅ Drafted |
| MVP Architecture | ✅ Drafted |
| ADR-0001 MVP Chain | ✅ Accepted |
| ADR-0002 First Use Case | ✅ Accepted |
| ADR-0003 POC Gas UX | ✅ Accepted |
| ADR-0004 Claim Authorization | ✅ Accepted |
| ADR-0005 POC Economics | ✅ Accepted |
| ADR-0006 On-chain Exposure Limits | ✅ Accepted |
| ADR-0007 World ID Integration | ✅ Accepted |
| ADR-0008 Signer Custody and Payout Limits | ✅ Accepted |
| ADR-0009 Quality Signals and Reputation Scope | ✅ Accepted |
| ADR-0010 Passive Accrual / Verify at Withdrawal | 📝 Proposed (post-M1) |
| ADR-0011 Idempotent Campaign Creation | ✅ Accepted; needs a Base Sepolia redeploy |
| API Spec v0 | ✅ Drafted |
| Contract Spec v0 | ✅ Drafted |
| Data Model v0 | ✅ Drafted |
| Claim Authorization Design | ✅ Drafted |
| Threat Model v0 | ✅ Drafted |
| Test Plan v0 | ✅ Drafted |
| Implementation skeleton | ✅ Monorepo scaffold |
| CampaignManager contract | ✅ Baseline implemented |
| Contract test suite | ✅ Unit + fuzz + invariants |
| JavaScript test suite | ✅ API, shared, and web (unit tests plus DOM tests of the mission and advertiser pages, #104) |
| CI | ✅ JavaScript + Foundry + local-chain E2E jobs, production dependency audit (high and critical) on every push and pull request and daily on `main`; failures as annotations |
| API persistence | ✅ Campaigns, missions, eligibility, submissions (#8, #15) |
| Engagement verifier | ✅ Deterministic comprehension check (#15) |
| Submission endpoint | ✅ Eligibility + verifier + persistence, 2-attempt cap |
| On-chain exposure limits | ✅ ADR-0006 (#18) |
| Deployment tooling / canonical ABI | ✅ Script + CI-checked ABI + fail-fast config; API and web use the canonical ABI at runtime; the API refuses a CampaignManager from before ADR-0011. The 2026-10-14 record is archived in `packages/contracts/deployments/archive/`; no current Base Sepolia record until the redeploy |
| Claim authorization service | ✅ EIP-712 signing, live on-chain checks, paid + outstanding cap, reissue after expiry (#10) |
| Wallet authentication (SIWE) | ✅ #37 |
| Chain indexer / reconciliation | ✅ Reorg-safe event worker and confirmed campaign state (#17, #16). Every committed range is hash-linked to the cursor and bloom-flagged blocks are proven complete from their receipts (#76, #102); links are read at the indexed block's hash (#76); recovery cannot race the worker (#77) |
| Advertiser analytics | ✅ Reconciled, advertiser-only via SIWE (#20, #37) |
| Observability | ✅ Request ids, redacted JSON logs, Prometheus metrics, payout anomaly alert, runbook (#21) |
| Privacy / retention | ✅ Policy, scheduled enforcement, wallet erasure (#22, docs/privacy/DATA_RETENTION.md) |
| Moderation / disputes | ✅ Review gate, URL policy, reports, take-down, append-only audit (#24, docs/operations/MODERATION.md) |
| Signer custody / payout limits | ✅ KMS signing service, rotation + pause drills, 24 h limit (#23, ADR-0008) |
| Public API contract | ✅ Scoped API keys, rate limits, retryable error model, versioning (#26, API_CONTRACT.md) |
| Production-readiness gate | 🟡 Reconciliation, backup/restore drill, incident process (#29); external review + named on-call pending |
| Quality signals | ✅ Campaign-scoped reason codes, fraud-adjusted analytics; cross-campaign reputation deferred (#25, ADR-0009) |
| Web flows | ✅ Advertiser create/fund (#11) and participant verify/answer/claim with the IDKit widget (#12); a lost RPC response, a retry or a second tab can never create a second campaign, because `createCampaign` is idempotent per draft (ADR-0011, #13). The advertiser page closes a campaign and refunds its unused budget with the advertiser's own wallet, offering each only when `CampaignManager` accepts it (#69). Unknown approve, fund, close and refund outcomes resolve without a reload, linking resumes after a transient 503, and a paid wallet sees "already paid" without a transaction (#78, #82, #86, #103). The mission page claims only on the chain the site is configured for, refuses a contract address without code, and shows a claim as paid only when its receipt has the claim's `RewardClaimed` event (#110, #115) |
| End-to-end POC | 🟡 Local anvil e2e in CI covers a lost RPC response, a concurrent resend and a same-parameter creation for another draft (ADR-0011). Base Sepolia: the v1 contract run on 2026-10-14 is complete (`docs/DEMO.md`); the run on the ADR-0011 contract is pending (#13) |
| World ID integration | ✅ Backend verification, RP signing and IDKit widget; a real production proof verified on Base Sepolia (ADR-0007, #9, #12). Only World ID 4.0 proofs are accepted (#74, PR #79); the 2026-10-14 proof may have been a 3.0 proof, so the re-run repeats it |
| Testnet deployment | 🟡 v1 `CampaignManager` (`0x12cc…DFEc`, 2026-10-14) ran the full flow with a real World ID proof; it is incompatible with ADR-0011 and retired. Redeploy and re-run pending (#13) |
| Operations runbook / alerts | ✅ docs/operations/RUNBOOK.md, docs/operations/alerts.yml; chain-halt and inconsistent-read alerts, built `:start` scripts, client-address topology for rate limits (#75, #76, #77) |

## Implementation Evidence

- Monorepo scaffold verified with `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build`, and `pnpm format:check`.
- `CampaignManager` implements campaign creation/funding, EIP-712 claims, close/refund, replay protection, completion caps, pause, signer rotation, and single-token settlement.
- Claim authorization now includes `issuedAt` + `expiresAt`; refunds wait until the issuance deadline plus maximum authorization TTL, eliminating the off-chain authorization/refund race in the original design.
- Foundry: 59 unit/fuzz tests plus 3 stateful invariants, every `CampaignManager` revert covered (#73).
- Stateful invariant run: 128 runs × 64 depth = 8,192 handler calls with zero invariant failures.
- Claim issuance checks the contract signer via RPC, matches the contract's EIP-712 typehash, caps distinct authorizations by campaign completion limit, and returns the same unexpired signature on retry.
- Base Sepolia run on 2026-10-14 (v1 contract, before ADR-0011) with a real World ID proof: funded 3 USDC, paid 1 USDC, refunded 2 USDC, contract balance 0; transactions in `docs/DEMO.md`.

## M1 review stack (merged 2026-11-02 UTC)

The PRs below reached `main` through #94, merged in the order their bases imply, with the conflicts between them resolved and CI (javascript with PostgreSQL, solidity, e2e) green. The stacked PRs were closed with a pointer to #94.

| PR | Closes or refs |
| --- | --- |
| #62 | Idempotent campaign creation, ADR-0011, Base Sepolia run record (#13) |
| #88 | Pool starvation and row-lock deadlock when signing acceptances (defects in #62) |
| #90 | Fixes #89, acceptance-time authorizations in the alert series (wired into #88's signing path) |
| #68 | Docs reconciled with the code |
| #79 | Fixes #74, World ID 4.0 proofs only |
| #81 | Closes #73, untested `CampaignManager` reverts |
| #83 | Refs #13 and #12, Base Sepolia re-run runbook |
| #84 | Closes #69, close and refund buttons |
| #85 | Refs #71, wallet-bound World ID signal |
| #87 | Closes #72, cookie sessions, CSRF checks, nonce CSP |
| #92 | Fixes #91, generic 500 body |
| #93 | The 2026-10-21 status update |
| #61, #66 | Proposed ADR-0010 and the x402 design review (#28); documents only, no decision |
| #63 | Short README entry point |

Owner gates:

- **Contract cleanup decision (#80).** Decide before the ADR-0011 redeploy, because the redeploy is the next time `CampaignManager` changes on-chain.
- **Redeploy and re-run.** Needs the owner's keys and the World App scan on the owner's phone. #12 and #13 close only after that run.
- **#71 closes only after the #13 swap test passes**, run exactly as ADR-0007 describes.

Open issues on 2026-11-11 (`gh issue list --state open`): #12 and #13 (M1) close after the Base Sepolia re-run; #80 and #70 are owner decisions (#80 has a recommendation in the issue, posted 2026-11-02 UTC); #74 and #71 wait for the #13 re-run; the epics #27, #28 and #29; the deferred decision #30 (multi-chain / AARC only with evidence of demand). #104 (DOM tests for the web pages) was closed by #115.

Recommended to the owner: the repository is public, and on 2026-11-11 Dependabot alerts, secret scanning and push protection were all disabled (`gh api repos/ChiJiun/verified-human-attention-market --jq .security_and_analysis`; `GET .../vulnerability-alerts` answers 404). Turn them on in the repository's **Settings → Code security** (the page may be named **Advanced Security**). Dependabot alerts report a new advisory against the lockfile without waiting for the next audit run; secret scanning reports a committed key, and push protection blocks a push that contains one (AGENTS.md §17). Only the owner can change these settings.

## Follow-ups merged 2026-11-02 (UTC)

Each was reviewed by a separate agent before merging, with the review recorded on the PR, and merged with green CI (javascript with PostgreSQL, solidity, e2e).

| PR | Closes | What changed |
| --- | --- | --- |
| #96 | #75 | CI smoke proves the `/api` rewrite forwards `X-Forwarded-For` unchanged; RUNBOOK documents the proxy topology and `TRUST_PROXY_HOPS=1` |
| #97 | #82 | A paid wallet gets `ALREADY_CLAIMED` instead of a stored authorization; the mission page simulates the claim and shows "already paid" without a transaction |
| #98 | #78, #86 | Linking resumes after a transient 503; `/publish` refuses a draft already created at the latest block; unknown close/refund outcomes resolve without a reload |
| #99 | #76 | Links are read at the indexed block's hash; the indexer commits only ranges hash-linked to its cursor and retries, rather than halts, on an inconsistent read |
| #100 | #77 | Deployment lock and cursor compare-and-set keep `reorg:recover` from racing the worker; `vham_chain_halted` gauge and alert; the built `:start` scripts run again |
| #101 | — | The API retries its startup chain check instead of crash-looping |
| #105 | — | Shared `campaignInput()` test fixture |
| #106 | #102 | Bloom-flagged blocks are proven complete from their receipts before a range commits |
| #107 | #103 | Unknown Approve and Fund outcomes resolve without a reload |

## Follow-ups merged 2026-11-04 (UTC)

Each was reviewed by a separate agent before merging, with the review recorded on the PR, and merged with green CI (javascript with PostgreSQL, solidity, e2e, and `audit` from #114 on).

| PR | Closes | What changed |
| --- | --- | --- |
| #109 | — | Docs reconciled with the code and GitHub state; the re-run runbook asks for the newest green `main` and checks for the fixes after #94 |
| #110 | — | The mission page claims only on the chain the site is configured for, and an unsupported `NEXT_PUBLIC_CHAIN_ID` fails fast instead of falling back to Base Sepolia |
| #111 | — | The API's remaining duplicated constants, patterns and fixtures are folded into one source each; one claim TTL constant; the `/metrics` 401 uses the catalog error shape |
| #112 | — | CI actions run on Node 24, and each test failure is annotated once |
| #113 | — | Dependency security patches (`next` 16.4.5, `fastify` 5.12.8, `zod` 4.6.7, a `ws` override, `fast-uri`, `vite`), so `pnpm audit --prod` is clean; the unused zod schemas leave `@vham/shared` |
| #114 | — | CI `audit` job for high and critical production advisories, third-party actions pinned by SHA, an annotation fallback, and tests of the claim TTL and expiry boundary |
| #115 | #104 | DOM tests for the mission and advertiser pages (jsdom); a claim shows as paid only with its `RewardClaimed` event, and a claim to an address without code is refused |
| #116 | — | Review follow-ups: a cancelled or replaced claim shows the hash mined in its place and can be claimed again after a reload; a daily `Dependency audit` workflow; `*.sh` checked out with LF; both claim repositories refuse a bad signer authorization through one `assertSignedFor` check |
| #118 | — | A submission before a campaign starts answers `CAMPAIGN_NOT_STARTED` again instead of `CAMPAIGN_NOT_ACTIVE`: the verifier checks the indexed campaign and the answers before the live contract read. Found in a local browser demo on anvil |
| #119 | — | Review follow-ups to #118: tests show that a refused submission sends no contract call, and the docs describe the verifier-first order (the API spec states that an accepted replay during a chain halt answers `200` with `CHAIN_HALTED`); the re-run runbook checks for #118 |
| #120 | — | Counter series that an `increase()` alert watches are exported at 0 from startup, so the first signer mismatch, signer outage, daily limit or payout anomaly alerts; a test checks the list against `alerts.yml`. The runbook states the remaining gaps: the deep reorg counter depends on a scrape before the worker exits (VhamChainHalted is the reliable signal), and the 5xx series are not listed. A test shows that during a chain halt an accepted replay answers `200` with `CHAIN_HALTED` and no authorization, and a new participant is refused without a stored submission |
| #121 | — | Monitoring gaps found in the #120 reviews: without World ID configured, `POST /world-id/request` refusals now count in `vham_world_id_requests_total`, which VhamWorldIdUnavailable also watches, and the runbook tells which variable is missing (without `PARTICIPANT_KEY_SECRET`, verification refuses instead); the indexer's last-success gauge starts when the worker takes the deployment lock, so a worker whose passes fail from its start raises VhamIndexerStalled (a first pass that catches up for over 5 minutes does too, and the runbook tells catching up from stuck by the lag); the API exports no indexer lag while there is no index cursor, so the lag from before `reorg:recover --apply` is not kept. The runbook says how to find the session that holds the deployment lock, and states what every `increase()` rule still misses (events before a first scrape or after a last one, restarts, counts per instance) and asks to scrape each instance as its own target; the VhamIndexerLag and VhamIndexerStalled runbook links reach their section, which a test now checks for every alert; tests check the 0-series key and that a halt is checked before any contract read |
| #122 | — | Review follow-ups to #121: the API exports the chain head and indexer lag only as read, so an RPC outage drops both and a database outage the lag, instead of keeping old values; the worker's wait for the deployment lock and the stall clock it starts are one tested function. The runbook and API spec state when the lag is absent, that on a new deployment a worker that never commits a range raises neither indexer alert, and how to select the API's lag by `job`; the World ID section names `WORLD_ID_RP_ID` again for provider errors. The alert tests read files with LF line ends, so code fences are recognised on a Windows checkout too |
| #123 | — | Review follow-ups to #122: a scrape exports one whole read of the chain head and indexer lag, also while a readiness check reads at the same time. The runbook states that a scrape that cannot read the RPC or the cursor can start VhamIndexerLag's 10 minutes over, that a worker restarting within 5 minutes of taking the lock raises no stall, how to tell the API's lag from the worker's, and that a retry does not help a wrong `WORLD_ID_RP_ID`. The lock test checks each wait's attempt and backoff. The alert tests require block-style rules and an `expr` that starts on its key's line, and no longer fail valid annotation templates or inline HTML comments |
| #124 | — | Review follow-ups to #123: an older chain read that finishes after a newer one no longer replaces it in the gauges, and tests cover overlaps of a scrape and a readiness check on every path, an older read that succeeds or fails after a newer one, and the cursor-failure path. The runbook asks for an API `scrape_timeout` of at least 20 s, since a scrape that times out raises neither VhamRpcDown nor VhamChainHalted, and says when a failed read restarts VhamIndexerLag, that a failing database pages through VhamChainHalted at once, and that a network error also counts as `PROVIDER_UNAVAILABLE`. The lock test checks the slept backoff. The alert tests skip scalar content when they look for keys, accept more PromQL starts and any first key in a group or rule, refuse quoted, explicit and merge keys, and give a heading with an inline HTML comment GitHub's anchor |

## Follow-ups merged 2026-11-05 (UTC)

Reviewed by a separate agent before merging, with the review recorded on the PR, and merged with green CI (javascript with PostgreSQL, solidity, e2e and `audit`).

| PR | Closes | What changed |
| --- | --- | --- |
| #125 | — | Review follow-ups to #124: the halt gauge orders its reads like the chain gauges, so an older halt read that finishes after a newer one no longer replaces it (one `orderedReads()` helper serves both). The alert tests parse `alerts.yml` with the `yaml` package, a new dev dependency of the API, instead of a hand-written line parser, so they check the parsed expressions rather than lines; the runbook anchor parser has a fixture test. The runbook states that only a database read can hang a scrape (a host that drops packets included), when a failed halt read raises VhamChainHalted, that a database that hangs leaves readiness without an answer, and that VhamRpcDown can miss an RPC that only times out now and then |

## Follow-ups merged 2026-11-08 (UTC)

Reviewed by a separate agent before merging, with the review recorded on the PR, and merged with green CI (javascript with PostgreSQL, solidity, e2e and `audit`).

| PR | Closes | What changed |
| --- | --- | --- |
| #126 | — | Review follow-ups to #125: the API refuses a metrics registry that another open app uses, since each app orders its own reads. The alert tests allow only the keys of Prometheus's rule format and count every range or subquery, unit-less ones included. The lockfile resolves vitest once for all packages. The runbook says when a database host that drops packets fails the whole scrape and when the scrape completes with `vham_chain_halted` at 1, that `connect_timeout` is a 30 s default, how VhamRpcDown can miss an RPC that fails on some reads and not others, and which requests answer 503 meanwhile |

## Follow-ups merged 2026-11-09 (UTC)

Reviewed by a separate agent before merging, with the review recorded on the PR, and merged with green CI (javascript with PostgreSQL, solidity, e2e and `audit`).

| PR | Closes | What changed |
| --- | --- | --- |
| #127 | — | Review follow-ups to #126: the API marks a metrics registry as in use only once the app is built, so a build that throws leaves it free, and frees it before the database closes, even when that close fails; tests pin both. The alert tests accept a rule file that uses every key of an alerting rule and count no `[` inside a raw string or after an escaped quote, and their comment names the files Prometheus accepts that fail here. The runbook adds publishing to the requests that answer 503 while the RPC fails, and says that a read sent on a busy connection hangs too, that a scrape completes with `vham_chain_halted` at 1 only with a `scrape_timeout` above `connect_timeout`, that `increase()` rules still see the samples from before a failed scrape, and when VhamIndexerStalled cannot fire |

## Follow-ups merged 2026-11-11 (UTC)

Reviewed by a separate agent before merging, with the review recorded on the PR, and merged with green CI (javascript with PostgreSQL, solidity, e2e and `audit`).

| PR | Closes | What changed |
| --- | --- | --- |
| #128 | — | Review follow-ups to #127: the indexer worker retries its startup read of the halt while the database cannot be read, instead of exiting and crash-looping under its supervisor, and its logs name the cause of a failed query, which Drizzle keeps apart from the message. Registry tests pin that the registry is freed before the database closes and that a build failing late leaves it free. The alert tests pin that `record` is refused next to `alert` and count a range between two strings once, and their comment lists more of the files Prometheus accepts that fail here. The runbook says that smart-contract wallets cannot sign in while the RPC fails and other wallets wait for it, that a read waiting for a connection can take twice `connect_timeout`, that a failed API scrape also restarts VhamIndexerLag on the API's series, why a lost lock can keep a restarted worker waiting, and that readiness logs no error for its 503s |

## Next SDLC Actions

1. Owner answers #80 (a recommendation is in the issue).
2. Redeploy `CampaignManager` (ADR-0011) to Base Sepolia, run the migration, and repeat the full flow (`docs/deployment/BASE_SEPOLIA_RERUN.md`); then close M1 (#12, #13) and, if the swap test passes, #71.
3. Decide ADR-0010 (passive accrual, World ID at login and withdrawal) and run the #22 privacy review it requires.
4. Production readiness for real funds stays gated by #29 (external security review, named on-call).
5. Owner turns on Dependabot alerts, secret scanning and push protection (the recommendation under the open issues above).

---

**Current gate:** The local economic loop is verified, including ADR-0011. The Base Sepolia flow was verified on the v1 contract and must be repeated on the ADR-0011 deployment. Real funds remain blocked by the production-readiness gate (#29).
