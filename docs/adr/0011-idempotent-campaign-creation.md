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
8. **The API refuses an older contract at startup:** `campaignIdByDraft` must answer, which a pre-ADR-0011 contract cannot (it reverts although it has code).

## Consequences

- Retries, concurrent tabs and lost responses can never create two campaigns for one draft; a duplicate costs only the reverted transaction's gas.
- A creation can never be linked to the wrong draft, even with identical parameters from the same wallet.
- The ABI changes (`createCampaign` selector `0x646c64f3`, new `CampaignCreated` topic). The contract deployed on Base Sepolia on 2026-10-14 (`0x12cc…DFEc`) is incompatible and must be replaced by a new deployment; its record stays as history.
- Campaigns created directly on the contract without a platform draft are never auto-linked (they name no known draft).
- Security: the change adds one storage write and one check to `createCampaign`; budget conservation, replay protection, claim and refund logic are untouched. Covered by Foundry unit tests (duplicate, per-sender scope, zero reference, event) and the e2e test (lost response, concurrent resend forced past wallet simulation, same-parameter campaign for another draft). Removing the duplicate check makes both fail.
