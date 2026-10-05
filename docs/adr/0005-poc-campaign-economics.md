# ADR-0005: POC Campaign Economics

- **Status:** Accepted
- **Date:** 2026-10-05
- **Scope:** POC only

## Decision

Use deliberately simple, non-market POC parameters.

### Default POC Campaign

| Parameter | Value |
| --- | ---: |
| Reward per valid completion | 1 test USDC |
| Maximum completions | 10 |
| Maximum campaign funding | 10 test USDC |
| Protocol fee | 0% |
| Minimum duration | 15 minutes |
| Maximum duration | 24 hours |

For local contract tests, use a mock ERC-20 with **6 decimals** to mirror USDC precision.

For public testnet, use only an officially documented test asset/address confirmed immediately before deployment.

## Why

These numbers are easy to inspect and reconcile:

```
10 completions × 1 USDC = 10 USDC maximum reward liability
```

The purpose is contract/accounting validation, not pricing discovery.

## Accounting Invariant

At all times:

```
paidRewards
+ outstandingAuthorizedLiabilities
+ protocolFees
+ refundableBalance
<= fundedBudget
```

For POC, protocol fee is zero, simplifying the first invariant and refund path.

## Not a Pricing Decision

These values MUST NOT be presented as the product's eventual market price.

Real MVP pricing must be determined from:

- advertiser willingness to pay;
- user willingness to participate;
- completion quality;
- fraud-adjusted completion rate;
- chain/payment costs.
