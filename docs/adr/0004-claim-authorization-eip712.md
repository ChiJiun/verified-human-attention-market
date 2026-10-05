# ADR-0004: Backend-Signed EIP-712 Claim Authorization

- **Status:** Accepted
- **Date:** 2026-10-05
- **Scope:** POC → MVP

## Decision

Use an off-chain engagement verifier that issues an **EIP-712 typed-data authorization** after a submission passes:

1. World ID verification;
2. campaign eligibility;
3. engagement/comprehension validation;
4. fraud/rate-limit checks.

The user submits this authorization to the reward contract.

## Signed Payload

```text
ClaimAuthorization {
  uint256 campaignId;
  address claimant;
  uint256 amount;
  bytes32 nonce;
  uint64 issuedAt;
  uint64 expiresAt;
}
```

The EIP-712 domain binds the signature to:

- contract name/version;
- chain ID;
- verifying contract.

## On-Chain Checks

The reward contract MUST verify:

- signature comes from an authorized signer;
- campaign exists and permits claim;
- claimant equals `msg.sender`;
- authorization is not expired and was not issued in the future;
- authorization lifetime does not exceed the contract's maximum authorization TTL;
- authorization was issued before the campaign's close/end issuance deadline;
- nonce has not been consumed;
- amount matches permitted campaign accounting;
- funded budget is sufficient.

The contract marks the nonce consumed before transferring funds.

## Duplicate Human Handling

World ID nullifier data remains off-chain for the POC/MVP verifier. The contract does not need the raw nullifier.

The backend MUST refuse a second reward authorization for the same World ID action/campaign according to campaign policy.

For defense in depth, the contract MAY also enforce one rewarded claim per wallet per campaign for the first mission type.

## Trust Assumption

A compromised authorized signer can issue fraudulent claims up to the financial limits enforced by the contracts.

Therefore POC/MVP requires:

- per-campaign budget limits;
- global payout limits where practical;
- pause capability;
- signer rotation;
- monitoring of unusual authorization/payout volume.

## Why EIP-712

- explicit typed fields;
- domain separation;
- standard EVM wallet/signature tooling;
- easier auditability than ad-hoc packed-message signatures.

## Production Revisit

Before scaling TVL, evaluate:

- HSM/KMS-backed signer;
- threshold authorization;
- scoped signers;
- on-chain or decentralized attestations;
- signer-specific payout ceilings.
