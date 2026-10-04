# ADR-0001: Use Base as the Initial POC/MVP Chain

- **Status:** Proposed
- **Date:** 2026-10-05
- **Decision owner:** Project owner
- **Scope:** POC / MVP

## Context

The application needs:

- EVM smart contracts;
- USDC settlement;
- low enough transaction costs for relatively small rewards;
- compatibility with standard wallet tooling;
- a future path to x402 machine payments;
- World ID support without forcing the application itself to be a World Chain Mini App.

Current official documentation indicates:

- Circle lists both Base and World Chain among native USDC-supported networks.
- World supports external World ID integrations for existing websites/apps.
- x402 v2 supports EVM networks and its specification includes Base Sepolia examples.

## Decision

Use **Base** as the working default for POC/MVP.

This is not a permanent multi-chain strategy. It is a deliberate choice to keep the first release single-chain.

## Why

### Advantages

- EVM-compatible.
- Native USDC support.
- Mature web wallet ecosystem.
- Strong fit with x402's EVM examples and future Agent/API direction.
- World ID can be integrated externally, so World Chain is not required merely for Proof of Human.
- Keeps payment and contract development straightforward.

### Trade-offs

- World Chain may offer stronger ecosystem alignment for a human-centric app.
- Base does not itself solve Proof of Human.
- Future buyers/users may hold liquidity elsewhere.

## Alternatives Considered

### World Chain

**Pros**

- Strong conceptual alignment with verified-human applications.
- Native USDC is currently listed by Circle.
- Direct World ecosystem alignment.

**Cons**

- Choosing it primarily because of World ID would unnecessarily couple identity choice and settlement chain.
- x402/agent-payment ecosystem alignment must be separately evaluated.

### Multi-chain from day one

Rejected for MVP because it adds bridge, reconciliation, liquidity, monitoring, and failure-mode complexity before demand is proven.

## Consequences

- Smart contracts target Base-compatible EVM.
- POC should use a Base test environment where practical.
- No bridging logic is included in MVP.
- AARC remains outside the critical path.
- Chain choice is reviewed if real buyer/user demand demonstrates a different requirement.

## Validation Sources

Checked on 2026-10-05:

- Circle USDC supported networks: https://www.circle.com/usdc
- World Developer Docs: https://docs.world.org/
- World API verification docs: https://docs.world.org/reference/api
- x402 v2 specification: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md

## Acceptance Gate

Before changing status from **Proposed** to **Accepted**:

- [ ] Project owner accepts Base as POC/MVP default.
- [ ] Confirm current testnet/mainnet USDC contract addresses from official Circle documentation immediately before implementation.
- [ ] Confirm current World ID SDK/API integration path immediately before implementation.
