# Roadmap — Verified Human Attention Market

[English README](README.md) | [繁體中文 README](README.zh-TW.md)

[English Roadmap](ROADMAP.md) | [繁體中文 Roadmap](ROADMAP.zh-TW.md)

This roadmap tracks product maturity from **POC → MVP → Beta → Production → Protocol / Ecosystem**.

It intentionally avoids fixed calendar dates until team capacity and the first target market are decided. Each milestone has explicit deliverables and exit criteria so progress is measured by evidence rather than by feature count.

---

## Roadmap Principles

- **Single-chain first.**
- **USDC before native token.**
- **World ID / Proof of Human is one anti-Sybil layer, not proof of engagement.**
- **x402 is introduced for API/agent payments after the core economic loop works.**
- **AARC / chain abstraction is deferred until real multi-chain demand exists.**
- **No production scaling before financial invariants, monitoring, and incident controls are in place.**
- **Optimize for verified valid completions, not raw clicks.**

---

## Current Status

| Area | Status |
| --- | --- |
| Product thesis | Defined |
| Initial architecture | Defined |
| SDLC | Defined |
| Threat model | Initial |
| MVP chain | Decision required |
| First customer/use case | Decision required |
| Smart contracts | Not started |
| Frontend | Not started |
| Backend | Not started |
| World ID integration | Not started |
| USDC settlement | Not started |
| x402 integration | Deferred |
| AARC integration | Deferred |

Current stage: **Planning / Requirements**

---

# Milestone 0 — Product Decision Gate

## Goal

Freeze the smallest problem worth proving before implementation begins.

## P0 Deliverables

- [ ] Select first customer segment:
  - advertisers / creators;
  - product research teams;
  - AI human-evaluation buyers.
- [ ] Define first mission type.
- [ ] Define what counts as a valid completion.
- [ ] Select MVP chain after checking current integration support.
- [ ] Confirm current USDC deployment/support on the selected chain.
- [ ] Confirm current World ID integration path.
- [ ] Decide gas model.
- [ ] Define first reward model.
- [ ] Define basic privacy/data-retention boundaries.
- [ ] Create ADRs for the major architecture decisions.

## Dependencies

None.

## Exit Criteria

A developer can explain the complete first flow:

> advertiser funds campaign → unique human completes mission → completion is verified → USDC is claimed → unused funds can be recovered

with no unresolved assumptions about identity, settlement, or campaign validity.

---

# Milestone 1 — POC: End-to-End Economic Loop

## Goal

Prove that the economic loop works technically.

## Scope

One chain, one mission, one advertiser, one verified user path.

## P0 Deliverables

### Contracts

- [ ] Campaign state machine.
- [ ] CampaignFactory.
- [ ] CampaignEscrow.
- [ ] Reward claim mechanism.
- [ ] Refund unused budget.
- [ ] Duplicate/replay protection.
- [ ] Contract events for indexing.

### Identity

- [ ] World ID proof flow.
- [ ] Campaign-specific uniqueness strategy.
- [ ] Proof replay handling.

### Backend

- [ ] Create/read campaign API.
- [ ] Completion verification endpoint.
- [ ] Claim authorization path.
- [ ] Idempotent completion handling.

### Frontend

- [ ] Advertiser wallet connection.
- [ ] Create/fund campaign screen.
- [ ] User mission page.
- [ ] World ID verification UX.
- [ ] Claim reward UX.

### Testing

- [ ] Contract unit tests.
- [ ] Basic invariant tests.
- [ ] End-to-end happy path.
- [ ] Duplicate claim test.
- [ ] Expired campaign test.
- [ ] Failed transfer / rejected wallet test.

## Explicitly Out of Scope

- x402;
- AARC;
- multi-chain;
- native token;
- DAO;
- sophisticated reputation;
- ML fraud detection;
- permissionless publisher ecosystem.

## Exit Criteria

On a development environment or testnet:

1. advertiser funds a campaign;
2. an eligible human completes the mission;
3. the system rejects a duplicate claim;
4. the valid claimant receives the expected reward;
5. contract accounting remains correct;
6. advertiser can recover unused budget.

---

# Milestone 2 — MVP: Real Buyer Validation

## Goal

Determine whether a real buyer will repeatedly pay for verified human completions.

## P0 Deliverables

- [ ] Real supported USDC settlement.
- [ ] Campaign expiration/refund.
- [ ] Basic advertiser dashboard.
- [ ] User mission feed.
- [ ] Basic campaign analytics.
- [ ] Event indexing.
- [ ] Mission result storage.
- [ ] Basic fraud rules.
- [ ] Basic reputation fields.
- [ ] Observability for API and blockchain failures.
- [ ] Privacy/data-retention policy.
- [ ] Admin/dispute tooling.

## P1 Deliverables

- [ ] Multiple campaign templates.
- [ ] User preference filters.
- [ ] Basic publisher attribution model.
- [ ] Exportable advertiser results.

## Key Metrics

- cost per verified valid completion;
- advertiser repeat rate;
- accepted completion rate;
- fraud-adjusted completion rate;
- campaign fill time;
- user earnings per active hour.

## Exit Criteria

At least one real buyer demonstrates repeated willingness to fund campaigns, and the product can measure fraud-adjusted unit economics.

---

# Milestone 3 — Closed Beta: Repeatability and Quality

## Goal

Show that the marketplace can operate repeatedly without manual intervention for every campaign.

## Deliverables

### Mission System

- [ ] Multiple mission types.
- [ ] Mission templates.
- [ ] Configurable eligibility and completion rules.
- [ ] Better comprehension / quality checks.

### Reputation

- [ ] Pseudonymous reputation model.
- [ ] Accepted-completion history.
- [ ] Domain/task-specific quality signals.
- [ ] Dispute impact on reputation.
- [ ] Abuse-resistant score update rules.

### Fraud

- [ ] Behavioral anomaly rules.
- [ ] Telemetry forgery detection.
- [ ] Human farming heuristics.
- [ ] Rate limits.
- [ ] Risk review tooling.

### Publisher

- [ ] First embeddable widget or SDK.
- [ ] Publisher attribution.
- [ ] Revenue-share accounting.

### API

- [ ] Stable campaign API.
- [ ] Stable completion/result API.
- [ ] API authentication and rate limits.
- [ ] Versioning policy.

## Exit Criteria

- campaigns can be created, completed, settled, and reported with limited operator intervention;
- fraud can be quantified rather than treated as an unknown;
- at least one external publisher or integration works end to end.

---

# Milestone 4 — Agent-Native Demand / x402

## Goal

Allow software and AI agents to purchase verified human work programmatically.

## Dependencies

- stable campaign API;
- stable settlement;
- reliable fraud controls;
- clear machine-readable task/result schema.

## Deliverables

- [ ] x402 feasibility validation against current ecosystem/specification.
- [ ] Machine-readable campaign creation endpoint.
- [ ] Programmatic payment flow.
- [ ] Agent-friendly task schema.
- [ ] Structured result retrieval.
- [ ] Idempotency and payment reconciliation.
- [ ] Per-agent limits / abuse controls.
- [ ] API documentation and examples.

## Example Target Flow

```
AI Agent
  → requests 100 verified human judgments
  → pays programmatically
  → campaign is created
  → humans complete tasks
  → agent retrieves structured results
```

## Exit Criteria

An external software client can purchase and retrieve verified-human work without a human operator manually funding each campaign.

---

# Milestone 5 — Production Readiness

## Goal

Operate with meaningful real funds and predictable incident handling.

## Smart Contract Security

- [ ] Unit tests.
- [ ] Fuzz tests.
- [ ] Invariant tests.
- [ ] Access-control review.
- [ ] Replay protection review.
- [ ] Budget accounting review.
- [ ] Pause/emergency mechanisms.
- [ ] Independent security review / audit appropriate to TVL.

## Infrastructure

- [ ] Production secrets/key management.
- [ ] Monitoring and alerting.
- [ ] RPC/provider failure handling.
- [ ] Database backup/restore.
- [ ] Queue/retry strategy.
- [ ] Financial reconciliation.
- [ ] Structured logging.
- [ ] On-call / incident process.

## Risk Controls

- [ ] Campaign funding limits.
- [ ] Daily payout limits.
- [ ] Suspicious-payout alerts.
- [ ] Signer anomaly alerts.
- [ ] Emergency pause runbook.
- [ ] Incident postmortem template.

## Privacy / Abuse

- [ ] Data-retention enforcement.
- [ ] User deletion/privacy workflow where applicable.
- [ ] Malicious campaign/content moderation.
- [ ] Phishing/scam controls.
- [ ] Publisher abuse controls.

## Exit Criteria

The platform can survive expected infrastructure failures and has a documented response path for financial/security incidents before limits are raised.

---

# Milestone 6 — Publisher Network

## Goal

Move distribution beyond the first-party website.

## Deliverables

- [ ] Public publisher SDK.
- [ ] Embeddable mission component.
- [ ] Revenue-share rules.
- [ ] Attribution system.
- [ ] Publisher analytics.
- [ ] Integration documentation.
- [ ] Versioned SDK releases.
- [ ] Sandbox environment.

## Exit Criteria

Multiple independent third-party properties can source users and receive auditable revenue share without custom one-off integration work.

---

# Milestone 7 — Protocol / Ecosystem

## Goal

Become infrastructure rather than only an application.

## Deliverables

- [ ] Stable public API.
- [ ] Stable SDK.
- [ ] Permissionless or semi-permissionless campaign integration model.
- [ ] Third-party mission providers.
- [ ] Agent-native demand.
- [ ] Publisher network.
- [ ] Reputation portability policy.
- [ ] Governance/security policy for protocol changes.

## Exit Criteria

A meaningful portion of demand and supply originates outside the first-party UI.

---

# Milestone 8 — Multi-Chain / AARC Decision Gate

## Goal

Add chain abstraction only when the market demonstrates that chain fragmentation is a real problem.

## Trigger Conditions

Proceed only if one or more are true:

- important advertisers hold funds on unsupported chains;
- users materially prefer reward settlement on other chains;
- publisher/agent partners require other networks;
- bridging friction measurably hurts conversion;
- liquidity/fees on the original chain become a material constraint.

## Validation Before Implementation

- [ ] Confirm current AARC SDK/API capabilities.
- [ ] Confirm supported networks.
- [ ] Review security/trust assumptions.
- [ ] Model bridge/swap failure states.
- [ ] Model additional fees.
- [ ] Define fallback and recovery behavior.
- [ ] Decide where canonical campaign accounting lives.

## Deliverables

Only if the decision gate passes:

- [ ] chain abstraction layer;
- [ ] cross-chain funding UX;
- [ ] cross-chain reward UX where justified;
- [ ] liquidity/reconciliation monitoring;
- [ ] cross-chain incident runbook.

## Exit Criteria

Users can interact without needing to understand the underlying chain, while accounting remains deterministic and failure recovery is documented.

---

# Cross-Cutting Workstreams

These run across milestones rather than belonging to only one release.

## Security

- threat model;
- contract invariants;
- key management;
- dependency review;
- incident response.

## Privacy

- data minimization;
- pseudonymous reputation;
- campaign-scoped identifiers;
- retention limits;
- deanonymization analysis.

## Fraud Intelligence

- Sybil signals;
- behavioral signals;
- publisher fraud;
- campaign abuse;
- anomaly datasets.

## Developer Experience

- API docs;
- SDK;
- examples;
- sandbox;
- versioning;
- backward compatibility.

## Market Design

- reward pricing;
- platform take rate;
- publisher share;
- reputation effects;
- dispute incentives.

---

# Priority Model

| Priority | Meaning |
| --- | --- |
| P0 | Required for current milestone / blocks validation |
| P1 | Important for quality and repeatability |
| P2 | Growth feature after core demand is proven |
| P3 | Only after evidence of need |

Current focus should remain on **P0 Milestone 0 → Milestone 1**.

---

# What We Should Not Build Yet

Until the core loop shows real demand:

- native token;
- DAO;
- speculative tokenomics;
- multi-chain settlement;
- AARC in the critical path;
- complex ML fraud scoring;
- fully decentralized engagement verification;
- large publisher marketplace;
- advanced auction/pricing system.

These may become useful later, but they currently add execution risk without validating the central hypothesis.

---

# Definition of Success

The first major proof point is not TVL, token price, or raw clicks.

It is:

> **A real buyer repeatedly pays for fraud-adjusted, verified-human completions because the output is more useful than conventional unverified traffic.**

Everything in the roadmap should support or test that statement.
