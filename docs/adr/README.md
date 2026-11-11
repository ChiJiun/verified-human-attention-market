# Architecture decisions (ADRs)

Each record explains one decision, the alternatives that were considered and the consequences. A record is accepted unless its status says otherwise; a new record is needed to change one.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-mvp-chain-base.md) | Base is the MVP chain; single chain first | Accepted |
| [0002](0002-first-use-case-sponsored-content.md) | First mission: sponsored content + a short comprehension check | Accepted |
| [0003](0003-poc-gas-ux.md) | In the POC the user pays testnet gas; revisit before real money | Accepted |
| [0004](0004-claim-authorization-eip712.md) | Claims are authorized off-chain with EIP-712 and verified on-chain | Accepted; amended by ADR-0011 |
| [0005](0005-poc-campaign-economics.md) | POC economics: 1 test USDC × max 10, 0% fee | Accepted |
| [0006](0006-onchain-exposure-limits.md) | Exposure limits enforced by the contract | Accepted |
| [0007](0007-world-id-integration.md) | World ID via IDKit, one action per campaign, no raw identity stored | Accepted |
| [0008](0008-signer-custody-and-payout-limits.md) | Claim-signer custody, admin roles and payout limits | Accepted |
| [0009](0009-quality-signals-and-reputation-scope.md) | Campaign-scoped quality signals, no cross-campaign reputation yet | Accepted |
| [0010](0010-passive-accrual-verify-at-withdrawal.md) | Earn while browsing, World ID at login and withdrawal | Proposed, not accepted |
| [0011](0011-idempotent-campaign-creation.md) | Idempotent on-chain campaign creation per draft (`draftRef`); a deep reorg halts signing | Accepted |

The rules that code must not break because of these decisions are in [AGENTS.md](../../AGENTS.md), section 4.
