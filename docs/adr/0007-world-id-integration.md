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
- Flow: `POST /v1/campaigns/:id/world-id/request` returns `appId`, `action`, `environment` and a fresh `rpContext`; the page draws a salt and derives the wallet-bound `signal` (update 2026-10-21), and the widget opens with them; `handleVerify` forwards the IDKit result **unchanged** (plus the claimant wallet and the salt) to `POST /v1/campaigns/:id/eligibility/verify` and throws if the API refuses, which puts the widget in its error state (`failed_by_host_app`). The proof is never logged, stored client-side, or echoed; `onError` shows only the error code, never the debug report.
- `environment` comes from the API (`WORLD_ID_ENVIRONMENT`), so the widget and the backend verifier cannot disagree.
- The page requests World ID 4.0 proofs only, with `constraints={CredentialRequest("proof_of_human", { signal })}` and `allow_legacy_proofs: false`. The API refuses 3.0 results. Until 2026-10-20 the page used the `proofOfHuman()` preset, which still allowed 3.0 proofs (see "Update 2026-10-20"). v3 and v4 nullifiers for one person differ, so accepting both would let one human obtain two eligibilities for the same campaign unless both were tracked. Revisit only with a dual-nullifier design.
- The page has no World ID mode of its own. It follows the `mode` the request route returns; the local anvil stand-in is `WORLD_ID_MODE=simulated` on the API, which refuses it on any other chain.

## Per-campaign actions and the Developer Portal (docs checked 2026-10-13, confirmed 2026-10-14)

The official IDKit, RP-signature and `POST /api/v4/verify/{rp_id}` documentation treats `action` as a free string: it is part of the RP signature (`hash_to_field(action)`), is passed in the request, and is echoed in the verify result. The verify reference lists no "action not found" error (only "App not found or no longer active"), and no page states that each action must be created in the portal first. "Create v4 actions" appears only in the 3.0 → 4.0 migration guide, in the context of migrating existing apps. Conclusion: **no per-campaign pre-registration is required by the documented flow**, and creating one portal action per campaign would not be feasible anyway.

**Confirmed on Base Sepolia, 2026-10-14:** a real World ID proof for `vham-campaign-<id>` verified successfully while the Developer Portal had no actions created. Per-campaign actions need no pre-registration. If World changes this, the fallback is one registered action with the campaign id carried in the signal.

## Update 2026-10-20: World ID 4.0 proofs only

The `proofOfHuman()` preset did not limit the request to 4.0 proofs. In `@worldcoin/idkit-core` 4.4.0, `compileRequest` sets `allowLegacy = true` for the `ProofOfHuman` preset and ignores `allow_legacy_proofs`. The package's type comment describes the preset as a 4.0 credential "with legacy Orb fallback". The API also accepted `protocol_version: "3.0"`. One human could therefore verify once with a 3.0 proof and once with a 4.0 proof, from two wallets, and get two eligibilities for one campaign.

- `apps/web/app/mission/page.tsx` passes `constraints={CredentialRequest("proof_of_human")}` with `allow_legacy_proofs={false}`. The bridge payload now carries `allow_legacy_proofs: false` and the same `proof_of_human` credential request (`issuer_schema_id` 1).
- `HttpWorldIdVerifier` accepts only `protocol_version: "4.0"`. A 3.0 result fails the payload schema with `INVALID_PROOF_PAYLOAD`, and the verifier never calls World's verify endpoint for it. The page cannot enforce this alone. The RP signature covers the nonce, the timestamps, and the action, but not the requested credential, so any client with a valid `rp_context` can still ask World App for a 3.0 proof.
- Each item in `responses` must also have the World ID 4.0 shape. It needs `identifier`, an integer `issuer_schema_id`, `nullifier`, an integer `expires_at_min`, and a `proof` array of exactly five strings. `signal_hash` is optional in this shape. The wallet-bound signal check (#71, below) requires it. A 3.0 item has `proof` as one string and a `merkle_root`, so a payload labelled 4.0 that carries one fails with `INVALID_PROOF_PAYLOAD` at the API. The refusal does not depend on World's server-side schema. Other fields pass through unchanged. The shape follows `ResponseItemV4` in `@worldcoin/idkit-core` 4.4.0. As of 2026-10-20, the [verify reference](https://docs.world.org/api-reference/developer-portal/verify) agrees on every field.
- The refusal reuses `INVALID_PROOF_PAYLOAD`. The page no longer asks for 3.0 proofs, so the refusal should reach only clients that bypass the page.
- The regression tests are `refuses a legacy World ID 3.0 result without calling World` and `refuses a 4.0 payload that carries a legacy item without calling World` in `apps/api/test/world-id.test.ts`.

As of 2026-10-20, the [World ID 4.0 migration guide](https://docs.world.org/world-id/4-0-migration) tells apps to "Track both nullifiers" while they still accept v3 proofs. [Introducing World ID 4.0](https://world.org/blog/engineering/introducing-world-id-4.0) derives the 4.0 nullifier with an oblivious pseudorandom function (OPRF) instead of the 3.0 hash of the user's identity secret. Neither page says in one sentence that the two values differ.

## Update 2026-10-21: wallet-bound signal with a browser salt (#71)

A proof is bound to the claimant wallet through the IDKit `signal`, so a proof produced for wallet A is refused for wallet B. Owner decision (2026-10-21): the signal is a hash over the campaign, the wallet and a random salt that the participant's browser draws. It replaces the server-derived HMAC signal of 2026-10-20.

**The signal.** `signal = keccak256(abi.encode(string "vham:world-id-signal:v2", string campaignId, address claimant, bytes32 salt))`, with the campaign id in lowercase (`worldIdSignal` in `packages/shared/src/world-id.ts`, shared by the page and the API). On every click of **Verify with World ID** the page draws 32 bytes with `crypto.getRandomValues`, derives the signal from the campaign id the API returned and the connected wallet, and opens IDKit with `CredentialRequest("proof_of_human", { signal })`. It then posts `{ claimant, signalSalt, idkitResponse }` to `POST /v1/campaigns/:id/eligibility/verify`, naming the wallet and the salt the proof was made for. The API derives the signal again from the campaign row, the claimant and the salt, and compares it with the result. The page keeps the salt in component state from the click until the IDKit widget closes, never in `sessionStorage`; the simulated path posts it at once and keeps nothing. The API never stores it and redacts `signalSalt` in logs.

**What World sees.** IDKit puts the signal itself into the request that World App decrypts (`compileConstraints` in `@worldcoin/idkit-core` 4.4.0 `dist/index.js`, lines 2618 to 2621; a `0x` string is sent as bytes, `signalBytes` at line 2561). World's verify endpoint receives `signal_hash = hashToField(bytes)` in the result. Both are keccak outputs over a salt that only the participant's browser and this API ever hold, so neither can be matched against the public on-chain claimants without the salt (AGENTS.md §13).

**Why the HMAC was dropped.** On 2026-10-20 the signal was `HMAC-SHA256(PARTICIPANT_KEY_SECRET, "vham:world-id-signal:v1" ‖ 0x00 ‖ campaignId ‖ 0x00 ‖ claimant)`, returned by the request route for any `claimant` in the body. The route needs no proof of wallet control, so anyone, World included, could query it for every on-chain claimant and rebuild the mapping the salt was meant to hide (review of PR #85, finding 2). A salt that never leaves the browser needs no server secret, no endpoint that returns it, and no extra wallet signature.

**Routes.** `POST /v1/campaigns/:id/world-id/request` takes no body and returns `{ mode: "live", appId, action, environment, rpContext }` or `{ mode: "simulated", action }`. It no longer needs `PARTICIPANT_KEY_SECRET`. `POST /v1/campaigns/:id/eligibility/verify` requires `signalSalt`, 32 bytes as `0x` hex, and answers `400 INVALID_ELIGIBILITY_REQUEST` without it. The verifier refuses, before calling World, any result in which a credential has no `signal_hash` or one that differs from the expected hash: `403 SIGNAL_MISMATCH`. Check order: payload schema, action, environment, signal, then World. A result mixing bound and unbound credentials is refused as a whole; the page requests exactly one credential. The hash is accepted in hex or decimal form. The anvil stand-in follows the same rule: its proof `{ action, simulatedHuman, signal }` must carry the signal derived from the posted salt. The e2e job builds its proofs this way and posts alice's proof and salt for bob, which must fail.

**What the API check proves.** In IDKit 4.4.0 the client always fills the `signal_hash` of a 4.0 result from its own `hashSignal(signal)`. `parseProtocolItem` (`dist/index.js` line 3037) reads no `signal_hash` from World App's response, and `convertProtocolResponse` (lines 3111 to 3135) copies the cached hash into every item (lines 3117 and 3129). The bridge path (`bridgeResponseToResult`, line 3281) and the native path (`proofResponseToIDKitResult`, line 3148) both go through it. Only a 3.0 result takes World App's own `signal_hash` first (lines 5053 and 5073). The API comparison therefore proves that the payload is consistent with the claimed signal, nothing more. The cryptographic binding depends on World's verify endpoint checking `signal_hash` against the proof, and no official page states that it does. The pages checked on 2026-10-20 (https://docs.world.org/api-reference/developer-portal/verify, https://docs.world.org/world-id/idkit/integrate, https://docs.world.org/world-id/4-0-migration) list `signal_hash` as an optional per-credential field with default `0x0`, say the signal lets an app "Bind specific context into the requested proof", and say "Your backend should enforce the same value".

**Hard condition before #71 closes.** On the #13 Base Sepolia run, take a real result for wallet A, set its `signal_hash` to the hash of wallet B's signal, and submit it for B with B's salt. The API must forward it and World must refuse it. If World accepts it, the signal binds nothing and this update must be revisited (the 3.0 protocol bound the signal as a proof input).

The signal carries the campaign id, so the fallback above (one registered action, campaign id in the signal) stays available.

## Consequences

- Rotating `PARTICIPANT_KEY_SECRET` breaks duplicate detection for running campaigns. Rotate only between campaigns.
- Cross-campaign reputation (#25) cannot reuse the participant key. That is intentional; it needs its own privacy design (#22).
