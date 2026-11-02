# Agent-Native Campaign Payment Design — Research Draft

> Status: **PROPOSED / UNVERIFIED** (not an accepted ADR, not implemented).
> Reviewed: 2026-10-16. Tracks [Issue #28](https://github.com/ChiJiun/verified-human-attention-market/issues/28).
> Scope: future Milestone 4 agent payment architecture. **No change to M1/M2/M3 priorities, current wallet funding, deployed contracts, or API behavior.**
> External design input (2026-10-15): a prospective x402 ecosystem integrator suggested EIP-3009 / direct-to-escrow funding. This is unverified feedback, **not** a MACH integration agreement, security audit, or compatibility guarantee.

## 1. Problem / non-goals

The current wallet path is `POST /v1/campaigns` (off-chain draft) followed by wallet transaction intents from `publishIntent()`:

1. `CampaignManager.createCampaign(...)` creates an on-chain draft and records `msg.sender` as advertiser.
2. The advertiser `USDC.approve(CampaignManager, amount)`.
3. The advertiser `CampaignManager.fundCampaign(campaignId, amount)`: only the recorded advertiser can call this, and the contract pulls funds with `transferFrom(msg.sender, address(this), amount)`.

That is not an autonomous one-authorization x402 purchase. A conventional x402 EVM `exact` transfer only moves tokens to `payTo`; it does **not** call `fundCampaign()`, set the contract's campaign ownership, or book campaign liabilities.

**Desired outcome:** an agent can purchase/fund verified-human work programmatically using **one economic payment**, with correct advertiser attribution, escrow accounting, and durable machine-readable confirmation. The existing direct-wallet path must remain usable.

**Not in scope:** human verification, engagement scoring, payout/claim redesign, native token, multi-chain, custody service, or automatic adoption of a third-party facilitator.

## 2. Source of truth and current moving branches

- Contract: [`packages/contracts/src/CampaignManager.sol`](../../packages/contracts/src/CampaignManager.sol).
- API transaction intents: [`apps/api/src/campaigns/onchain.ts`](../../apps/api/src/campaigns/onchain.ts).
- API routes: [`apps/api/src/campaigns/onchain-routes.ts`](../../apps/api/src/campaigns/onchain-routes.ts).
- Existing API requirements: [`docs/architecture/API_SPEC.md`](./API_SPEC.md); threat model: [`docs/threat-model/THREAT_MODEL.md`](../threat-model/THREAT_MODEL.md).
- **Important concurrent work:** [PR #62](https://github.com/ChiJiun/verified-human-attention-market/pull/62) proposes a contract `draftRef`, idempotent campaign creation, changed events/ABI, and `campaignIdByDraft` mapping. It is **not assumed merged** by this draft. Any future funding design must review the **merged ABI and deployed version** first, and bind the actual draft reference, not only a numeric `campaignId`.
- [PR #63](https://github.com/ChiJiun/verified-human-attention-market/pull/63) rewrites READMEs. Do not duplicate or conflict with that documentation migration.

## 3. Source-checked x402 / EIP-3009 constraints (2026-10-16)

1. The official x402 **EVM exact** scheme defaults to USDC EIP-3009 `transferWithAuthorization()`; it also documents Permit2 and ERC-7710 paths. For the EIP-3009 path, the facilitator broadcasts a **token transfer** — arbitrary CampaignManager calls are not guaranteed.
2. `transferWithAuthorization` and `receiveWithAuthorization` sign **different EIP-712 message types**. A standard x402 exact signature for the former cannot simply be passed to the latter.
3. Circle's `receiveWithAuthorization()` requires **`to == msg.sender` at the token call**; if the recipient is CampaignManager, the *CampaignManager contract itself* must make that call. A relayer or adapter calling USDC on CampaignManager's behalf fails this condition.
4. Even when `transferWithAuthorization(from, CampaignManager, ...)` succeeds, a token balance increase alone is **not** booked campaign escrow. A third party may submit the signed authorization directly before a proposed funding entry point can consume it (front-running / consumed authorization), leaving unallocated funds if the design assumes the later bookkeeping call succeeds. **Atomicity and recovery must be demonstrated, not assumed.**
5. Standard EIP-3009 typed fields are `from, to, value, validAfter, validBefore, nonce`. They do not include `campaignId`, `draftRef`, or an application order ID as first-class fields. The authorization nonce can be associated with an order in storage, but **an API-side association alone is not an on-chain authorization check**.
6. Signatures must be validated against the real chain ID, verified token address, token EIP-712 domain version, transfer method, expiry, payer, amount, and destination. Check the deployed Base Sepolia token's implementation; do not hardcode token/contract addresses from emails or old examples.

References:
- [x402 official EVM exact scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md)
- [Circle USDC EIP-3009 implementation](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol)
- [x402 protocol](https://github.com/x402-foundation/x402)

These references must be rechecked **immediately before implementation**; this document is a research snapshot, not a protocol conformance claim.

## 4. Alternatives — no decision yet

| Candidate | Payment/execution | Upside | Blocker / test required |
| --- | --- | --- | --- |
| **A. Keep direct-wallet baseline** | Advertiser signs `createCampaign`, `approve`, `fundCampaign` | Already fits ownership and accounting; reliable fallback | Manual on-chain wallet steps; no native agent purchase |
| **B. Custom `receiveWithAuthorization` escrow entry point** | CampaignManager validates explicit campaign authorization and calls USDC `receiveWithAuthorization` in the **same** transaction | Potential atomic transfer + escrow bookkeeping with no intermediate custodian | Requires a **ReceiveWithAuthorization** signature, not the standard x402 `TransferWithAuthorization` payload; custom adapter/scheme/client support; advertiser binding still needed |
| **C. Standard x402 `transferWithAuthorization` directly to escrow** | Standard facilitator broadcasts USDC transfer to configured `payTo` | Compatible with ordinary x402 EVM exact transfer | No automatic campaign accounting. Separate booking creates race/front-run/stranded-fund risks. **Do not implement as funded until atomic linkage is proven** |
| **D. Explicitly authorized delegated/batched execution** | Sponsored smart-account / scoped delegated operation or another audited atomic payment execution method | May integrate payment and campaign operations in one verified execution | Wallet requirements, facilitator compatibility, gas/fees, replay bounds, contract changes; needs its own threat review |

**Research order:** preserve A; investigate B (custom method, never mislabel it standards-compliant), compare with D if B cannot interoperate; reject naive C unless there is a proved atomic mechanism. A separate intermediary wallet plus a second token transfer is **not** the default architecture because it introduces custody, extra execution, and failure surfaces.

## 5. Proposed architecture boundaries (subject to PoC)

### Campaign ownership and funding

For the **first PoC**, preserve **advertiser-created on-chain campaigns**. The on-chain advertiser remains the intended wallet, **not** the relayer or facilitator. Only consider relayed creation later with a separately scoped advertiser signature binding the chain, deployed contract, draft reference, campaign economics, nonce/deadline and execution permissions.

A successful purchase must bind the following to **one canonical on-chain funding record**:

- off-chain `draftId` and, after PR #62 if merged, `draftRef`;
- `chainId`, exact CampaignManager deployment, USDC token address/domain;
- on-chain `campaignId`, advertiser, payer, expected integer USDC amount, expiry;
- signed authorization identity/nonce, receipt/tx hash, funding event, confirmation block;
- durable idempotency key and settlement attempt history.

A funding entry point must verify the exact advertiser/campaign relationship and required budget; it may not authorize arbitrary withdrawals or redirect payments. The active balance, liabilities, campaign status, and refund paths must continue to enforce existing budget invariants. Never let one external relayer become an unrestricted operator.

**One economic payment** means the campaign budget is transferred from payer once and accounted for once. Multiple network messages, an RPC retry or sponsored gas payment are not independently new campaign budgets.

### API sketch — proposed, NOT active endpoints

- `POST /v1/campaigns`: existing idempotent draft.
- `POST /v1/campaigns/:id/purchase`: **candidate** negotiation/response for the exact campaign-specific x402 payment requirement and submitted signed authorization; exact HTTP 402 challenge/receipt semantics TBD after protocol review. Never return “paid” at authorization time.
- `GET /v1/campaigns/:id`: confirmed chain-derived campaign/funding state.
- `GET /v1/campaigns/:id/analytics`: existing results once available.

Treat `payment_authorized` (signature received), `settlement_pending` (broadcast or unknown receipt), `funding_confirmed` (finalized escrow accounted on canonical chain), and `work_completed` (separate human workflow) distinctly. Temporary RPC failure, timeout, or ambiguous receipt must yield a pending/reconciling status, **never automatic payment reissuance**.

The client must be able to query and resume an existing purchase by draft and idempotency key without accidentally creating a different liability. Reconciliation remains authoritative; neither HTTP 200 nor a payment-provider response alone activates the campaign.

## 6. Security gates and proof obligations

No Solidity/API implementation without passing all relevant checks below. Add specific threat-model entries once a design is chosen.

- **Authorization binding:** wrong payer, wallet, advertiser, chain, token, contract version, campaign ID / draftRef, token domain, amount, expiry, or nonce must fail.
- **One use:** duplicate requests, conflicting idempotency payload, reused authorization, simultaneous relayers, and separate drafts with identical budgets cannot double fund or cross-allocate.
- **Adversarial ordering:** a third party front-runs or consumes the authorization, tx mined but server times out, ERC-20 returns odd responses, token transfer succeeds but bookkeeping would fail. Demonstrate atomicity or explicit safe recovery for every allowed state.
- **Funding accounting:** escrow funds equal budget booked for that campaign, with no activation before canonical confirmed settlement, no orphan allocation, no unauthorized refund/claim path. Verify balance, emitted events and storage state; account for reorg and deployed-contract migration (#62).
- **Permission boundaries:** unauthorized relayer/adapter calls, stolen API key, leaked signature, wrong-chain replay, expired authorization, and overbroad approvals cannot steal or reroute money.
- **Gas/custody:** document who pays gas, how much, whether an approval step exists, and whether any intermediate account holds funds. No mainnet user funds during exploratory testing.
- **Provider independence:** separate the x402 protocol from any specific third-party endpoint. Public provider compatibility and production support are unverified until independently tested.
- **Failure observability:** every ambiguous payment can be reconciled by signature nonce, chain event, and transaction identifier; repeated payment is never the default response.

## 7. Minimal PoC (Base Sepolia, after existing M1 gates)

1. Confirm the merged `CampaignManager` ABI, #62 `draftRef` mapping (if adopted), deployed token's EIP-3009 domain/functions, and Base Sepolia funding contract.
2. Create **one advertiser-owned campaign** with the smallest safe test USDC budget. Produce exactly **one** signed authorization bound to the intended purchase.
3. Implement a proof-only funding path showing **one authorized USDC movement + one escrow booking**, either atomically or with a fully specified, tested alternative; emit a verifiable linkage event.
4. Show campaign funding status only after the canonical receipt/confirmation; inspect token balance, campaign record and event on-chain.
5. Resend exact request, race two requests, use same amount on a different draft, and replay consumed authorization; **zero additional funds/liabilities**.
6. Exercise wrong payer, chain, token, campaign/draft, amount, deadline, signature, and double-use attempts; all must revert/refuse.
7. Simulate lost broadcast response, dropped receipt, RPC outage and reorg. Query/restore status without instructing the client to pay twice.
8. Preserve and regression-test existing direct-wallet path, claims, refunds, reentrancy/budget invariants, and indexer.
9. Record Foundry tests, API integration tests, actual Base Sepolia transaction links (if run), on-chain balances, code review findings and any unresolved risk. No “completed” status without independent reproducible evidence.

**Exit gate:** architecture accepted only after reproducible tests, a specific approved ADR, reviewed upgrade/migration plan, and owner approval. Do not mark Issue #28 done just because a proposal exists.

## 8. Open decisions for owner / design reviewers

1. Must v1 support standard x402 `exact/eip3009` payloads **unchanged**, or is a custom client/settlement path acceptable?
2. How can a standard payment receipt be cryptographically and atomically tied to `draftRef` and escrow booking, or should a different payment scheme be used?
3. Does the intended wallet population include EOAs only or smart accounts (EIP-1271 / delegation)? Who sponsors gas?
4. What are the non-custodial recovery/refund rules for unexpected token transfers or a consumed authorization with no campaign funding event?
5. Which confirmation/reorg policy and idempotency keys span API, adapter, token authorization nonce, and contract?
6. Are current Milestone 1 security gates finished, and which deployment/ABI is safe to extend?
7. Does a possible external collaborator provide inspectable adapter code and tests, or only architectural suggestions? **Do not grant special trust merely based on email.**

Decision on advertiser-created vs relayed creation: **propose advertiser-created for the first PoC only**, pending owner approval. No deployment or production integration implied.

## 9. Workflow / ownership

This document is a non-blocking research artifact for [Issue #28](https://github.com/ChiJiun/verified-human-attention-market/issues/28). Continue the project-defined implementation order in [`AGENTS.md`](../../AGENTS.md). Do not alter `CampaignManager`, `API_SPEC`, `THREAT_MODEL`, or SDLC status based on this proposal alone. Follow architecture-change rules: create a **new accepted ADR only after evaluation** and then update specs and tests together.

Revision rule: compare against `main` and live contract deployments again immediately before implementation, especially after PR #62 and PR #63 merge.
