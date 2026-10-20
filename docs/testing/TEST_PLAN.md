# Test Plan v0

> Status: System Design  
> Goal: make acceptance criteria executable before mainnet exposure.
>
> Reconciled with the implemented suites: 2026-10-20

Where a case is implemented, the test name is given in brackets.

Suites and how to run them: `pnpm test` (Vitest: `apps/api/test`, `packages/shared/test`; the PostgreSQL suite `postgres.integration.test.ts` runs when `TEST_DATABASE_URL` is set, always in CI), `pnpm --filter @vham/api test:e2e` (`apps/api/e2e/poc.e2e.ts` against anvil, CI job `e2e`), `forge test` in `packages/contracts` (CI job `solidity`).

# Contract Tests

## Unit

- campaign creation validation [`test_RewardAboveLimitRejected`, `test_CompletionsAboveLimitRejected`, `test_BudgetAboveLimitRejected`, `test_VeryLargeDirectCallsRejected`, `test_ZeroDraftRefRejected`, `test_DuplicateDraftRefReverts`, `test_DraftRefIsScopedToTheAdvertiser`, `test_CampaignWindowEdges`];
- funding [`test_CreateFundAndClaim`, `test_FundingAfterEndRejected`, `test_FundingForAnotherDraftRejected`, `test_InvalidFundingAmountRejected`, `test_FundingTwiceRejected`, `test_CancelUnfundedDraft`, `test_CannotCancelFundedCampaign`];
- lifecycle transitions [`test_PreCloseAuthorizationRemainsClaimableAfterClose`, `test_PostCloseAuthorizationRejected`, `test_RefundWaitsForAuthorizationGracePeriod`];
- valid claim [`test_CreateFundAndClaim`];
- invalid signer [`test_InvalidSignerRejected`, `test_SignerRotationRevokesOldSignatures`];
- expired authorization [`test_ExpiredAuthorizationRejected`];
- authorization timing [`test_AuthorizationNotYetValidRejected`, `test_AuthorizationLifetimeTooLongRejected`, `test_AuthorizationIssuedBeforeStartRejected`, `test_InvertedAuthorizationWindowRejected`; the `expiresAt <= issuedAt` half of the lifetime guard is redundant, because `AuthorizationNotYetValid` and `AuthorizationExpired` reject every such window first];
- wrong claimant [`test_WrongClaimantRejected`];
- wrong reward amount [`test_InvalidClaimAmountRejected`];
- consumed nonce [`test_DuplicateNonceRejected`, `test_OneWalletCannotClaimTwice`];
- max completions reached [`test_CompletionLimitReached`];
- wrong draft [`test_ClaimRejectsAnotherDraftsAuthorization`, `test_AuthorizationForReorgedDraftCannotClaimTheNewCampaign`];
- close/expiry [`test_PostCloseAuthorizationRejected`, `test_AuthorizationIssuedAfterEndRejected` (a campaign that was never closed accepts an authorization issued at its end and refuses one issued a second later); expiry window via the invariant handler];
- refund [`test_OnlyAdvertiserCanRefund`, `test_RefundWaitsForAuthorizationGracePeriod`];
- pause and ownership [`test_PauseBlocksClaims`, `test_OnlyOwnerCanPauseAndPauseBlocksRefunds`];
- backend/contract agreement [`test_ClaimAuthorizationTypehashMatchesBackend`, `test_EventTopicsMatchIndexer`, `test_FunctionSelectorsMatchIndexer`];
- deployment script [`DeployCampaignManager.t.sol`: configured limits, wrong chain, missing addresses, token without code, out-of-range limit, deployment JSON fields];
- exposure limits [`test_InvalidExposureLimitsRejected`, `test_ExposureLimitBoundariesAccepted`], creation event [`test_CampaignCreatedCarriesDraftRef`];
- signature encoding [`test_InvalidSignatureLengthRejected`, `test_InvalidSignatureSRejected` (the high-s twin of a valid signature, which `ecrecover` alone accepts), `test_InvalidSignatureVRejected`, `test_SignatureVZeroOrOneAccepted` (a recovery id of 0 or 1 counts as 27 or 28)];
- guards no public sequence reaches [`test_AlreadyFundedRejected`, `test_InsufficientCampaignBudgetRejected`; both set storage with `vm.store`. Funding writes `fundedBudget` and leaves Draft in one transaction, and each claim adds exactly one reward and one completion to a budget of `rewardPerCompletion * maxCompletions`, so `InvalidCampaignStatus` and `CompletionLimitReached` always fire first. The guards matter only if that accounting breaks, and then they stop a campaign from paying out of the escrow shared by all campaigns].

## Fuzz

- funding amounts and completion counts [`testFuzz_FundingEqualsMaximumLiability`, `testFuzz_CreateNeverExceedsExposureLimits`];
- claim order and close/refund timing [stateful handler in `CampaignManager.invariant.t.sol`: `claim`, `close`, `refund`, `advanceTime`];
- reward amount boundaries [`test_ExposureLimitBoundariesAccepted` plus the fuzz above];
- campaign timestamps [`testFuzz_CampaignDurationBounds` (one second below, at and above the minimum and maximum duration), `testFuzz_CampaignStartInThePastRejected`, `test_CampaignWindowEdges`].

## Invariants

At minimum:

1. paid + refunded never exceeds funded [`invariant_BudgetIsConserved`, `invariant_PaidRewardsNeverExceedFunding`; there is no on-chain reservation — outstanding authorizations are bounded off-chain by the issuance cap, see CLAIM_AUTHORIZATION.md];
2. consumed nonce cannot become reusable [`test_DuplicateNonceRejected`; the handler never reuses a nonce];
3. paid completions never exceed max completions [`invariant_CompletionsStayWithinCap`];
4. only advertiser receives campaign refund [`test_OnlyAdvertiserCanRefund`; `refundUnusedBudget` transfers to `campaign.advertiser` only];
5. paused state prevents financial claim mutations as designed [`test_PauseBlocksClaims`, `test_OnlyOwnerCanPauseAndPauseBlocksRefunds`].

# API Tests

- create campaign input validation [`campaigns.test.ts`, `moderation.test.ts` (URL policy)];
- invalid/expired campaign submission [`submissions.test.ts`, `verifier.test.ts`];
- idempotency same request / conflict [`campaigns.test.ts`, `submissions.test.ts`, `persistence.test.ts`, `postgres.integration.test.ts`];
- World ID verification failure [`world-id.test.ts`, `eligibility.test.ts`, `rp-signature.test.ts`];
- engagement rejection [`verifier.test.ts`, `submissions.test.ts`];
- signer failure and signer mismatch [`claims.test.ts`, `remote-signer.test.ts`; acceptance rolled back when signing fails: `submissions.test.ts`, `postgres.integration.test.ts`];
- claim issuance cap, reissue, deep-reorg relink [`claims.test.ts`, `postgres.integration.test.ts`];
- on-chain linking, live campaign checks, status sync, auto-link, recovery [`onchain.test.ts`];
- indexer (batches, provider failure, shallow/deep reorg, halt) [`chain-indexer.test.ts` + `support/indexer-contract.ts`, run against both repositories];
- analytics reconciliation [`reconciliation.test.ts`, `onchain.test.ts`];
- authentication, API keys, rate limits, moderation, observability, retention [`auth.test.ts`, `api-clients.test.ts`, `moderation.test.ts`, `observability.test.ts`, `postgres.integration.test.ts`];
- chain configuration fail-fast [`chain-config.test.ts`, `canonical-abi.test.ts`];
- health endpoints [`health.test.ts`], quality signals [`quality.test.ts`], shared package [`packages/shared/test/{amount,contracts,deployment}.test.ts`]; the persistence rules run against both repositories through `test/support/persistence-contract.ts`;
- database retry behavior [not planned: the API uses idempotent requests and the `retryable` error flag instead of a server-side retry layer (API_CONTRACT.md)].

# Integration Tests

All five scenarios run in one anvil test, `apps/api/e2e/poc.e2e.ts` (real contracts, real API, PostgreSQL; World ID simulated), plus the Base Sepolia run recorded in `docs/DEMO.md`.

## E2E-001 Happy Path

```
create → fund → verify human → submit (signed at acceptance) → claim → index → analytics
```

## E2E-002 Duplicate Human

Second completion for same campaign/person policy is rejected before a second authorization.

## E2E-003 Duplicate Claim

Same authorization submitted twice; second transaction fails.

## E2E-004 Closed / Expired Campaign

No new accepted completion after the close (the API reads the contract live); a completion accepted before the close stays claimable.

## E2E-005 Refund

After liabilities resolve, correct remainder returns to advertiser; reconciliation (contract ↔ indexed events ↔ issued authorizations) reports no findings.

## E2E-006 Idempotent Creation (ADR-0011)

Lost RPC response, concurrent resend and a same-parameter creation for another draft never produce a second campaign or a wrong link.

# Failure Injection

- RPC timeout after transaction broadcast [e2e: lost response, link by `draftRef`];
- database transaction retry [not planned, see API Tests];
- World ID provider unavailable [`world-id.test.ts`: `PROVIDER_UNAVAILABLE`, no eligibility written];
- signer unavailable [`claims.test.ts`, `remote-signer.test.ts`; acceptance rolled back];
- indexer restart / provider outage mid-pass [`indexer-contract.ts`: resumes without losing or duplicating events];
- stale chain state / reorg [`indexer-contract.ts`: shallow reorg orphans events, deep reorg halts, logs read across a reorg are never committed; `onchain.test.ts`: recovery];
- pause and signer rotation drill [e2e].

# CI Gate

Implementation PRs should not merge if:

- contract tests fail;
- API unit/integration tests fail;
- typecheck fails;
- lint fails;
- generated schema/ABI changes are unreviewed.

# Mainnet Beta Gate

Mainnet financial exposure remains capped until:

- contract unit + fuzz + invariant tests pass;
- E2E critical paths pass;
- signer handling is reviewed;
- observability exists;
- emergency pause is tested;
- independent security review is appropriate for the planned exposure.
