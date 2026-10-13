# ADR-0007: World ID Eligibility Integration

- **Status:** Accepted
- **Date:** 2026-10-12
- **Issue:** #9
- **Sources (checked 2026-10-12, re-checked 2026-10-13):** https://docs.world.org/world-id/idkit/integrate, https://docs.world.org/world-id/idkit/react, https://docs.world.org/world-id/idkit/signatures, https://docs.world.org/api-reference/developer-portal/verify

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

## Web widget (#12, checked 2026-10-13)

- `apps/web` uses `@worldcoin/idkit` **4.4.0** (pinned) and its `IDKitRequestWidget`.
- Flow: `POST /v1/campaigns/:id/world-id/request` returns `appId`, `action`, `environment` and a fresh `rpContext`; the widget opens with them; `handleVerify` forwards the IDKit result **unchanged** (plus the claimant wallet) to `POST /v1/campaigns/:id/eligibility/verify` and throws if the API refuses, which puts the widget in its error state (`failed_by_host_app`). The proof is never logged, stored client-side, or echoed; `onError` shows only the error code, never the debug report.
- `environment` comes from the API (`WORLD_ID_ENVIRONMENT`), so the widget and the backend verifier cannot disagree.
- Preset `proofOfHuman()` with `allow_legacy_proofs: false`: World ID 4.0 proofs only. v3 and v4 nullifiers for one person differ, so accepting both would let one human obtain two eligibilities for the same campaign unless both were tracked. Revisit only with a dual-nullifier design.
- `NEXT_PUBLIC_WORLD_ID_MODE=simulated` keeps the local anvil stand-in (the API refuses it on any other chain).

## Per-campaign actions and the Developer Portal (checked 2026-10-13)

The official IDKit, RP-signature and `POST /api/v4/verify/{rp_id}` documentation treats `action` as a free string: it is part of the RP signature (`hash_to_field(action)`), is passed in the request, and is echoed in the verify result. The verify reference lists no "action not found" error (only "App not found or no longer active"), and no page states that each action must be created in the portal first. "Create v4 actions" appears only in the 3.0 → 4.0 migration guide, in the context of migrating existing apps. Conclusion: **no per-campaign pre-registration is required by the documented flow**, and creating one portal action per campaign would not be feasible anyway.

This is read from documentation, not observed against a live app. The Base Sepolia run (#13) is the real test; if the portal rejects unknown actions there, this ADR must change (for example to one registered action plus the campaign id carried in the signal).

## Not yet covered

- **Wallet-bound signal:** IDKit can bind the claimant wallet as the proof `signal`, and the backend can check `signal_hash`. This needs keccak256 and a verifier change. Until then, proof relay is mitigated by TLS and the one-wallet-per-human binding.

## Consequences

- Rotating `PARTICIPANT_KEY_SECRET` breaks duplicate detection for running campaigns. Rotate only between campaigns.
- Cross-campaign reputation (#25) cannot reuse the participant key. That is intentional; it needs its own privacy design (#22).
