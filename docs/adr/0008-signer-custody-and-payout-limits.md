# ADR-0008: Claim Signer Custody, Admin Roles and Payout Limits

- **Status:** Accepted
- **Date:** 2026-10-13
- **Scope:** Gate for any real-money deployment; POC/testnet keep working
- **Issue:** #23 (Threat Model T-004, T-014)

## Context

ADR-0004 makes the backend signer the trust anchor for payouts: whoever holds
the key can authorize claims up to every funded budget. In the POC the key is
an environment variable (`CLAIM_SIGNER_PRIVATE_KEY`). That is acceptable for
test USDC, not for real money.

## Decision

### 1. Signer custody

- **Production:** the key is generated in and never leaves a KMS/HSM
  (e.g. AWS KMS `ECC_SECG_P256K1`). The API reaches it through a signing
  service that speaks `eth_signTypedData` — [Web3Signer](https://docs.web3signer.consensys.com/reference/api/json-rpc)
  in eth1 mode supports AWS KMS keys (docs checked 2026-10-13).
  Configure `CLAIM_SIGNER_URL` + `CLAIM_SIGNER_ADDRESS` (+ optional
  `CLAIM_SIGNER_AUTHORIZATION`). The API:
  - checks at startup that the service holds the address (`eth_accounts`);
  - recovers every returned signature locally and refuses it unless it is
    from that address over the exact payload it asked for;
  - fails closed (`503 SIGNER_UNAVAILABLE`) on timeouts and errors.
- **Plaintext keys** (`CLAIM_SIGNER_PRIVATE_KEY`) are refused at startup on
  any chain other than local anvil (31337) and Base Sepolia (84532).
- The signing service runs on a private network; only the API can call it.

### 2. Roles (separation of duties)

| Role | Holder | Powers | Cannot |
| --- | --- | --- | --- |
| Contract owner | Multisig (production), deployer key (testnet) | `pause`, `unpause`, `setAuthorizedSigner`, `transferOwnership` | Move or withdraw funds; change exposure limits (immutable, ADR-0006) |
| Claim signer | KMS key via signing service | Sign claim authorizations | Anything on-chain except as a claim signature; it holds no ETH |
| API | Service | Decide who gets an authorization, within limits | Sign without the signing service in production |
| Moderation operator | SIWE wallets (#24) | Approve/take down campaigns | Touch funds or settlement records |

Owner, signer and operator must be different keys. In production the owner
is a multisig with at least 2 of 3 signers; `transferOwnership` to it is part
of deployment.

### 3. Payout limits

| Layer | Limit | Enforced by |
| --- | --- | --- |
| Per completion / campaign | `maxRewardPerCompletion`, `maxCompletionsPerCampaign`, `maxCampaignBudget` | Contract (immutable, ADR-0006) |
| Per campaign, outstanding | paid + unexpired authorizations ≤ `maxCompletions` | API, row lock (#10) |
| Global, 24 h | Sum of rewards authorized in the last 24 h ≤ `DAILY_PAYOUT_LIMIT_ATOMIC` (default 100 test USDC) → `503 DAILY_LIMIT_REACHED` | API, PostgreSQL advisory lock |
| Burst | > 10 per campaign or > 50 overall in 5 min → alert | API metrics (#21) |

The on-chain caps bound loss even if the signer is fully compromised: an
attacker can drain at most the funded, unclaimed budgets, each at most
`maxCampaignBudget`. The 24 h limit and burst alert bound how fast an API-side
compromise or bug can create liability.

### 4. Emergency controls

- `pause()` stops claims and refunds instantly; there is no owner withdrawal,
  so pausing never puts funds at the owner's discretion.
- `setAuthorizedSigner(new)` revokes every outstanding signature of the old
  key at once.
- Both are exercised in CI: Foundry tests and the local-chain E2E drill
  (pause → claim fails → unpause; rotate → old signature fails and the API
  returns `SIGNER_MISMATCH` → rotate back). Procedures:
  `docs/operations/RUNBOOK.md`.

## Consequences

- A real-money deployment requires: a KMS key, a signing service, a multisig
  owner, and a reviewed `DAILY_PAYOUT_LIMIT_ATOMIC`. None of these are needed
  for local or Base Sepolia demos.
- Signing adds a network hop (default timeout 5 s) inside the issuance
  transaction; issuance volume in the MVP is low enough for this.
- Base mainnet is still not enabled in the chain configuration; enabling it
  is a separate decision.

## Alternatives considered

- **Encrypted keystore file on the API host:** the decrypted key still lives
  in API memory and the password in its environment. Rejected for
  production.
- **On-chain daily limit:** would require a contract change and an owner
  setter (more admin power). The immutable per-campaign caps already bound
  total loss; the daily limit is a rate control and lives in the API.
