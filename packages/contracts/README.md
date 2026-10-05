# @vham/contracts

Solidity financial layer for campaign escrow and reward settlement.

## Current implementation

`CampaignManager.sol` is the POC/MVP financial baseline. It currently covers:

- campaign creation and exact-budget funding;
- one configured USDC-like reward token;
- EIP-712 claim authorization;
- nonce replay protection;
- one rewarded claim per wallet per campaign for the first mission;
- completion and budget caps;
- manual close and expiry-aware refund grace period;
- pause/unpause;
- authorized signer rotation;
- ownership transfer.

The signed claim includes `issuedAt` and `expiresAt`. Refunds are delayed until the campaign issuance deadline plus `MAX_AUTHORIZATION_TTL`, so valid pre-close authorizations can settle before unused funds are returned.

## Development

Foundry v1.8.4 is the current local/CI baseline.

```bash
forge fmt --check
forge build --sizes
forge test -vv
```

The test suite includes unit cases, fuzzing, and stateful invariants for budget conservation and completion bounds.

Design references:

- `../../docs/architecture/CONTRACT_SPEC.md`
- `../../docs/architecture/CLAIM_AUTHORIZATION.md`
- `../../docs/testing/TEST_PLAN.md`

Tracking:

- GitHub issue #14 — CampaignManager implementation
- GitHub issue #7 — contract unit/fuzz/invariant tests
