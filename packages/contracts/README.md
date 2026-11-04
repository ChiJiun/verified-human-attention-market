# @vham/contracts

Solidity financial layer for campaign escrow and reward settlement.

## Current implementation

`CampaignManager.sol` is the POC/MVP financial baseline. It currently covers:

- campaign creation and exact-budget funding;
- idempotent creation per draft (ADR-0011): `createCampaign` takes a nonzero `draftRef`, records it in `campaignIdByDraft[advertiser][draftRef]`, and reverts with `DraftAlreadyCreated(campaignId)` when the advertiser already created a campaign for it; `fundCampaign` and the signed `ClaimAuthorization` carry the same `draftRef` and revert with `WrongDraft` when it does not name the campaign;
- one configured USDC-like reward token;
- EIP-712 claim authorization;
- nonce replay protection;
- one rewarded claim per wallet per campaign for the first mission;
- completion and budget caps;
- immutable deployment-time exposure limits (ADR-0006);
- unfunded draft cancellation and no funding after `endTime`;
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

The test suite includes unit cases, fuzzing, and stateful invariants for budget conservation and completion bounds, plus tests of the deployment script and pins of the event topics and selectors (`test/DeployCampaignManager.t.sol`, `test/EventTopics.t.sol`).

### Deployment and ABI

- `script/DeployCampaignManager.s.sol` deploys to a testnet and fails before broadcasting on a wrong chain, a zero address, a USDC address without code, or a limit that does not fit its on-chain type. It writes `deployments/<chainId>.json`, which is committed as the deployment record. See [`docs/deployment/TESTNET.md`](../../docs/deployment/TESTNET.md).
- `script/DeployLocal.s.sol` deploys a mock USDC and `CampaignManager` to anvil (chain 31337) for the local demo ([`docs/DEMO.md`](../../docs/DEMO.md)). Its `deployments/31337.json` is git-ignored.
- `deployments/archive/` keeps retired records. `84532-2026-10-14-pre-adr-0011.json` is the Base Sepolia contract from before ADR-0011, which the redeploy replaces.
- `scripts/export-abi.mjs` writes the canonical ABI from the `forge build` output to `packages/shared/src/contracts/campaign-manager-abi.ts`. After a contract change, run `forge build && node scripts/export-abi.mjs` here, then `pnpm --filter @vham/shared build`. CI runs `node scripts/export-abi.mjs --check` and fails if the committed ABI drifts.

Design references:

- `../../docs/architecture/CONTRACT_SPEC.md`
- `../../docs/architecture/CLAIM_AUTHORIZATION.md`
- `../../docs/adr/0011-idempotent-campaign-creation.md`
- `../../docs/testing/TEST_PLAN.md`

Tracking:

- GitHub issue #14 — CampaignManager implementation
- GitHub issue #7 — contract unit/fuzz/invariant tests
- GitHub issue #18 — on-chain exposure limits
- GitHub issue #19 — deployment script, ABI export, shared contract configuration
- GitHub issue #80 — cleanup decision before the ADR-0011 redeploy
