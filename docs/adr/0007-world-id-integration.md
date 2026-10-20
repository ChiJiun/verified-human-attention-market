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
- Flow: `POST /v1/campaigns/:id/world-id/request` with the connected wallet as `claimant` returns `appId`, `action`, `environment`, a fresh `rpContext` and the wallet-bound `signal` (update 2026-10-20); the widget opens with them; `handleVerify` forwards the IDKit result **unchanged** (plus the claimant wallet) to `POST /v1/campaigns/:id/eligibility/verify` and throws if the API refuses, which puts the widget in its error state (`failed_by_host_app`). The proof is never logged, stored client-side, or echoed; `onError` shows only the error code, never the debug report.
- `environment` comes from the API (`WORLD_ID_ENVIRONMENT`), so the widget and the backend verifier cannot disagree.
- The page requests World ID 4.0 proofs only, with `constraints={CredentialRequest("proof_of_human", { signal })}` and `allow_legacy_proofs: false`. The API refuses 3.0 results. Until 2026-10-20 the page used the `proofOfHuman()` preset, which still allowed 3.0 proofs (see "Update 2026-10-20"). v3 and v4 nullifiers for one person differ, so accepting both would let one human obtain two eligibilities for the same campaign unless both were tracked. Revisit only with a dual-nullifier design.
- `NEXT_PUBLIC_WORLD_ID_MODE=simulated` keeps the local anvil stand-in (the API refuses it on any other chain).

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

## Update 2026-10-20: wallet-bound signal (#71)

A proof is bound to the claimant wallet through the IDKit `signal`, so a proof produced for wallet A is refused for wallet B. Owner decision (2026-10-20): the signal is a salted value produced by the API, not the wallet address.

- `signal = HMAC-SHA256(PARTICIPANT_KEY_SECRET, "vham:world-id-signal:v1" ‖ 0x00 ‖ campaignId ‖ 0x00 ‖ lowercase claimant)`, sent as a `0x`-prefixed 32-byte hex string (`apps/api/src/identity/world-id-signal.ts`). IDKit hashes a `0x` hex signal as bytes (`hashSignal` in `@worldcoin/idkit-core` 4.4.0) and puts `signal_hash = hashToField(bytes)` into every credential of the result. The API computes the same value with viem's Keccak-256, pinned to vectors from the installed package, and compares.
- Why salted: World receives `signal_hash` in every proof it verifies. With the plain address as the signal, `hashToField(address)` is cheap to compute for every public on-chain claimant, so World could link nullifiers to wallets, which this ADR and AGENTS.md §13 avoid. An HMAC under a server secret cannot be matched against public addresses without that secret. The participant-key secret is reused under its own domain tag, so no new secret or variable: HMAC outputs on distinct messages reveal nothing about each other, and the secret already rotates only between campaigns.
- Flow: `POST /v1/campaigns/:id/world-id/request` takes `{ claimant }` (an EVM address, any case; `400 INVALID_ELIGIBILITY_REQUEST` without one) and returns `signal` next to the existing fields. The page opens IDKit with `CredentialRequest("proof_of_human", { signal })` and posts the result with the same wallet. `POST /eligibility/verify` derives the signal for the claimant it is given, and the verifier refuses, before calling World, any result in which a credential has no `signal_hash` or one that differs from the expected hash: `403 SIGNAL_MISMATCH`. Verifier check order: payload schema (a 4.0 result whose items have the 4.0 shape), action, environment, signal, then World. A result mixing bound and unbound credentials is refused as a whole; the page requests exactly one credential. The hash is accepted in hex or decimal form.
- The local anvil stand-in (`WORLD_ID_MODE=simulated`) follows the same rule: the request route returns `{ appId: null, action, signal }` for it, and its proof `{ action, simulatedHuman, signal }` must carry that signal. The e2e job uses this stand-in.
- The signal message already carries the campaign id, so the fallback above (one registered action, campaign id in the signal) stays available.
- Pending (#13 Base Sepolia run): the check has not been exercised against a real World App. The API's comparison only shows that the result *claims* the expected signal; the binding is real only if World's verifier rejects a 4.0 proof whose `signal_hash` was altered. The official pages checked on 2026-10-20 (https://docs.world.org/api-reference/developer-portal/verify, https://docs.world.org/world-id/idkit/integrate, https://docs.world.org/world-id/4-0-migration) list `signal_hash` as an optional per-credential field with default `0x0`, say the signal lets an app "Bind specific context into the requested proof" and that "Your backend should enforce the same value", but do not state that `POST /api/v4/verify/{rp_id}` checks it against the proof. In IDKit 4.4.0 the result's `signal_hash` is filled from the client's own `hashSignal(signal)` when the World App returns none. Test on #13: take a real result for wallet A, set its `signal_hash` to the hash of wallet B's signal, and submit it for B; the API must pass it to World and World must refuse it. If World accepts it, the signal binds nothing and this update must be revisited (the 3.0 protocol bound the signal as a proof input).

## Consequences

- Rotating `PARTICIPANT_KEY_SECRET` breaks duplicate detection for running campaigns. Rotate only between campaigns.
- Cross-campaign reputation (#25) cannot reuse the participant key. That is intentional; it needs its own privacy design (#22).
