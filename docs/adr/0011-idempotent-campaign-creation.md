# ADR-0011: Idempotent Campaign Creation with a Draft Reference

- **Status:** Accepted (owner decision, 2026-10-15)
- **Date:** 2026-10-15
- **Issue:** #13 (RPC timeout / retry without duplicate economic action)
- **Changes:** `CampaignManager.createCampaign`, `CampaignCreated`, the `POST /v1/campaigns/:id/onchain` contract (API_SPEC), and requires a new Base Sepolia deployment

## Context

`writeContract` returns the transaction hash only after the node answers. When the response is lost after broadcast, the client has no hash, and the old contract had no way to tell whether a draft's campaign already existed. Client-side recovery (recording a nonce before sending and searching for the transaction afterwards) was reviewed and still left two failure modes:

- two tabs or devices could both see "not created" and send, creating two campaigns;
- a transaction for a different draft with identical parameters could be attributed to this draft.

A single RPC observation cannot prove a transaction was not broadcast, so no client-only scheme can make a retry safe.

## Decision

1. `createCampaign(reward, maxCompletions, startTime, endTime, bytes32 draftRef)`. The contract stores `campaignIdByDraft[msg.sender][draftRef]` and reverts with `DraftAlreadyCreated(campaignId)` for a second creation with the same reference, and with `InvalidDraftRef` for zero.
2. The mapping is keyed by the **sender**, so nobody can front-run and occupy another advertiser's reference.
3. `CampaignCreated(uint256 indexed campaignId, address indexed advertiser, bytes32 indexed draftRef)`.
4. The API derives `draftRef = keccak256("vham-draft:" + draftId)` and returns it in the publish intent.
5. Linking requires the event's `draftRef` to equal the draft's (`DRAFT_MISMATCH` otherwise). `POST /onchain` without a hash links through `campaignIdByDraft(advertiser, draftRef)`; "not created yet" is `202 reconciling`. The indexer auto-link matches drafts by `draftRef` instead of by economics.
6. The web app keeps no transaction state: it first asks the API to link by draft; only then sends. A retry is always safe because the contract refuses a duplicate.

7. **Deployments are kept apart in the database.** On-chain ids restart at 1 on every deployment, so a campaign link is `(chain_id, onchain_contract_address, onchain_campaign_id)` (migration 0011). Status sync, auto-link, reconciliation and analytics only read campaigns linked to the configured contract, and the claim service refuses to sign for a campaign linked to another contract. Such a campaign is **retired**: the World ID request, eligibility and submission endpoints refuse it too, so nobody completes work that could not be paid here. Rows linked before the migration are marked `pre-adr-0011`. Switching contracts therefore requires settling the old one first (TESTNET.md checklist).
8. **The API and the indexer worker refuse an older contract at startup:** `campaignIdByDraft` must answer, which a pre-ADR-0011 contract cannot (it reverts although it has code). Transport and provider errors are reported as RPC problems, not as an old contract.
9. **A deployment is (chain, contract).** The same address on another chain is another deployment; participant endpoints, the claim service and the web app's funding all use the shared `isCurrentDeployment` rule (`@vham/shared/deployment`).
10. **Links are made only from final data and re-checked.** A creation is linked once it is `INDEXER_CONFIRMATIONS` deep. Status sync skips a link whose confirmed creation names another draft or advertiser; auto-link releases such a link and links the draft the canonical creation names; the claim service signs only if `campaignIdByDraft(advertiser, draftRef)` still equals the linked id. A transaction-hash link additionally requires the receipt's block to still be canonical (`getBlock(number).hash == receipt.blockHash`) and the mapping at the confirmed block to name this id. The indexer re-reads the range's end block before and after `getLogs` and checks every log's block hash, so it never commits logs read across a reorg.
11. **A reorg deeper than the confirmation depth halts the deployment.** The indexer worker records the halt in `indexer_halts` (retrying until it is stored) and stops; the API refuses all participation and signing with `CHAIN_HALTED`. `reorg:recover` re-checks every link against the contract at the confirmed head (mapping **and** creation parameters), releases the stale ones (`creation_missing`, `id_changed`, `parameters_changed`), drops the index and marks the halt *recovery applied* — it does **not** clear it. The restarted worker rebuilds from the deploy block and clears the halt only once the index has caught up to the confirmed head and every link verifies again; until then the API keeps refusing. `INDEXER_CONFIRMATIONS` must be a positive integer for both processes.
12. **Acceptance means payable.** Before recording a completion, the submission endpoint reads the campaign live from the contract: this draft's mapping, its parameters, `Active`, `closedAt == 0`, remaining budget ≥ reward, completions below the cap and within the window (`409 CAMPAIGN_NOT_ACTIVE` otherwise, `503 CHAIN_UNAVAILABLE` if the RPC fails). The claim authorization is signed in the same request and returned with the acceptance, so a later close cannot strand an accepted completion (the contract accepts an authorization issued up to `closedAt`). If signing fails, the response says `pending_authorization` with the reason code and the authorization endpoint can be called again.
13. **The draft reference is part of the signed claim.** `ClaimAuthorization` carries `draftRef`, and `claim` reverts with `WrongDraft` unless `campaignIdByDraft[advertiser][draftRef] == campaignId`. After a deep reorg the same id can belong to another draft; an authorization signed for the old draft can then never be redeemed against the new campaign's budget.
14. **Funding checks the target in the wallet's own view.** Before `approve`/`fund`, the web app checks the wallet's chain id and reads `campaignIdByDraft` and `campaigns(id)` from the wallet's provider (`isFundingTarget`); a mismatch stops before any money moves.

## Consequences

- Retries, concurrent tabs and lost responses can never create two campaigns for one draft; a duplicate costs only the reverted transaction's gas.
- A creation can never be linked to the wrong draft, even with identical parameters from the same wallet.
- The ABI changes (`createCampaign` selector `0x646c64f3`, new `CampaignCreated` topic). The contract deployed on Base Sepolia on 2026-10-14 (`0x12cc…DFEc`) is incompatible and must be replaced by a new deployment; its record stays as history.
- Campaigns created directly on the contract without a platform draft are never auto-linked (they name no known draft).
- Security: the change adds one storage write and one check to `createCampaign`, and one mapping read to `claim` (`WrongDraft`, decision 13); budget conservation, replay protection and refund logic are untouched. The EIP-712 type string changes, so signatures from the previous contract are not valid on the new one. Covered by Foundry unit tests (duplicate, per-sender scope, zero reference, event) and the e2e test (lost response, concurrent resend forced past wallet simulation, same-parameter campaign for another draft). Removing the duplicate check makes both fail.
