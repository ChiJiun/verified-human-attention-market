# ADR-0007: World ID Eligibility Integration

- **Status:** Accepted
- **Date:** 2026-10-12
- **Issue:** #9
- **Sources (checked 2026-10-12):** https://docs.world.org/world-id/idkit/integrate, https://docs.world.org/world-id/reference/api

## Context

World ID is the anti-Sybil layer (README §6). The current official integration is IDKit with RP-signed requests on the client and backend verification via `POST https://developer.world.org/api/v4/verify/{rp_id}`. The IDKit result is forwarded unchanged; the response carries per-credential results and nullifiers. Nullifiers are scoped **per app and per action**.

## Decision

1. **One World ID action per campaign:** `vham-campaign-{campaignId}`. The nullifier is therefore campaign-scoped by construction. A human gets one eligibility per campaign, and nullifiers for different campaigns are unlinkable.
2. **Backend verification only:** `HttpWorldIdVerifier` checks the action and environment locally, forwards the IDKit result to the v4 verify endpoint, and accepts only a nullifier that the user submitted and World reported as verified.
3. **Store no raw identity material.** The decimal nullifier is immediately turned into `participant_key = HMAC-SHA256(PARTICIPANT_KEY_SECRET, campaignId ‖ nullifier)` (`deriveParticipantKey`). A DB `CHECK` and the repository both refuse non-derived keys. Proof payloads are neither persisted nor logged nor echoed in responses.
4. **One wallet per verified human per campaign:** enforced by `UNIQUE(campaign_id, participant_key)` and `UNIQUE(campaign_id, claimant_address)`. Re-verifying with the same wallet is idempotent; switching wallets is rejected (`PARTICIPANT_WALLET_MISMATCH`, `WALLET_ALREADY_BOUND`).
5. **Fail closed:** without `WORLD_ID_RP_ID` and `PARTICIPANT_KEY_SECRET`, the endpoint returns `503 WORLD_ID_NOT_CONFIGURED`. Provider outages return `503`, and no eligibility is written.
6. Eligibility expires at the campaign `endAt`.

## Update 2026-10-13: RP signature endpoint (#12)

`POST /v1/campaigns/:id/world-id/request` returns the campaign action and an
`rp_context` (`rp_id`, `nonce`, `created_at`, `expires_at`, `signature`) for
IDKit. The signature follows the published algorithm
(https://docs.world.org/world-id/idkit/signatures, checked 2026-10-13):
EIP-191 secp256k1 over `0x01 ‖ nonce ‖ created_at ‖ expires_at ‖
hash_to_field(action)`, 300 s TTL. It is implemented with viem's Keccak-256
and signing (`apps/api/src/identity/rp-signature.ts`) instead of
`@worldcoin/idkit-core/signing`, because that package cannot be installed in
the current build environment; the implementation is pinned to the official
test vectors, so swapping in `signRequest` later is a drop-in change. The key
(`RP_SIGNING_KEY`) stays server-side; without it the endpoint returns
`503 WORLD_ID_NOT_CONFIGURED`. The endpoint is moderation-gated and in the
sensitive rate-limit bucket.

## Not yet covered

- **IDKit widget in the web app** (`@worldcoin/idkit`) — needs the package in the lockfile.
- **Wallet-bound signal:** IDKit can bind the claimant wallet as the proof `signal` and the backend can check `signal_hash`. This needs keccak256 and lands with the EIP-712 work (#10). Until then, proof relay is mitigated by TLS and the one-wallet-per-human binding.
- Whether per-campaign actions must be pre-registered in the Developer Portal must be confirmed in the portal before testnet E2E (#13).

## Consequences

- Rotating `PARTICIPANT_KEY_SECRET` breaks duplicate detection for running campaigns. Rotate only between campaigns.
- Cross-campaign reputation (#25) cannot reuse the participant key. That is intentional; it needs its own privacy design (#22).
