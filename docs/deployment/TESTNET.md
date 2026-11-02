# Base Sepolia Deployment Runbook

> Issue #19. External facts checked on **2026-10-12**, re-checked **2026-10-13** (chain ID 84532, public RPC, and the Circle USDC address were unchanged). Re-check them immediately before every deployment (AGENTS.md §19).

> **Redeploy required (ADR-0011, 2026-10-15).** `createCampaign` now takes a `draftRef`, so the contract deployed on 2026-10-14 (`0x12cc9447CEb3f8E75dDf4463A1A4D9feB42bDFEc`, run recorded in `docs/DEMO.md`) is incompatible with the current API and web app. Its record is archived in `deployments/archive/`. The API refuses to start against it: it has code, but `campaignIdByDraft` reverts.

## Moving to a new CampaignManager

On-chain campaign ids restart at 1 on every deployment, so the database links campaigns by `(chain, contract, id)` (migration 0011). The same database can be kept.

**Before switching: settle the old contract.** After the switch the API refuses every campaign linked to the old contract: no new World ID verifications or completions, and no claim authorizations (not even re-sending an unexpired one). So switch only when the old contract owes nothing:

- every campaign on it ended more than `MAX_AUTHORIZATION_TTL` (15 minutes) ago, so no issued authorization can still be claimed, and
- each one is `settled` (closed and refunded) or `cancelled`.

Run this against the old database before migrating; it must return no rows:

```sql
SELECT id, onchain_campaign_id, status, end_at
FROM campaigns
WHERE onchain_campaign_id IS NOT NULL
  AND status NOT IN ('settled', 'cancelled');
```

For a campaign still listed: wait until it ends plus 15 minutes, let participants claim, then have the advertiser close and refund it on the old contract (see `docs/DEMO.md`). Only accept leftovers deliberately, knowing those participants can no longer get an authorization from this API.

Then:

1. Stop the API and the indexer worker.
2. Run `pnpm --filter @vham/api db:migrate`. Campaigns linked before this migration are marked `pre-adr-0011`: they keep their history but are retired here: never synced or signed for, closed to new World ID verifications and completions, and never shown with events from another contract.
3. Deploy (below). The script writes a new `deployments/84532.json`; commit it.
4. Set `CAMPAIGN_MANAGER_ADDRESS` and `CAMPAIGN_MANAGER_DEPLOY_BLOCK` from the new record. Indexed events and the indexer cursor are scoped by contract address, so indexing starts fresh from the new deploy block.
5. Start the API and the indexer worker. Both verify the chain, the contract code and that `campaignIdByDraft` answers (an older contract reverts); an RPC or provider error is reported as such, not as an old contract. Both use `INDEXER_CONFIRMATIONS`: the API only links creations buried that deep.

Campaigns on the old contract cannot move: create new drafts.

| Fact | Value | Source |
| --- | --- | --- |
| Chain | Base Sepolia, chain ID `84532` | https://docs.base.org/base-chain/quickstart/connecting-to-base |
| Public RPC | `https://sepolia.base.org` (use a dedicated provider for anything beyond smoke tests) | same |
| Explorer | https://sepolia.basescan.org | same |
| Test USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle) | https://developers.circle.com/stablecoins/usdc-contract-addresses |

## POC exposure limits (ADR-0005 / ADR-0006)

| Env | Value |
| --- | --- |
| `MAX_REWARD_PER_COMPLETION` | `1000000` (1 USDC) |
| `MAX_COMPLETIONS_PER_CAMPAIGN` | `10` |
| `MAX_CAMPAIGN_BUDGET` | `10000000` (10 USDC) |

Raising a limit requires a new deployment and an ADR update.

## Keys

- **Deployer / owner:** use a Foundry encrypted keystore (`cast wallet import deployer --interactive`). Never put a private key in `.env` or the repository.
- **Claim signer:** a separate key whose **address** goes in `CLAIM_SIGNER_ADDRESS`. The private key is configured only on the API (`CLAIM_SIGNER_PRIVATE_KEY`, #10) and must never be the deployer key.

## Deploy

```bash
cd packages/contracts
export EXPECTED_CHAIN_ID=84532
export USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
export CLAIM_SIGNER_ADDRESS=0x...            # claim signer address
export MAX_REWARD_PER_COMPLETION=1000000
export MAX_COMPLETIONS_PER_CAMPAIGN=10
export MAX_CAMPAIGN_BUDGET=10000000

forge script script/DeployCampaignManager.s.sol \
  --rpc-url "$EVM_RPC_URL" --account deployer --broadcast
```

The script reverts **before broadcasting** if the RPC chain differs from `EXPECTED_CHAIN_ID`, an address is zero, the USDC address has no code, or a limit does not fit its on-chain type.

It writes `packages/contracts/deployments/<chainId>.json` with chain ID, contract address, deploy block, owner, signer, reward token and limits. Commit that file; it is the auditable deployment record.

## Configure the API

Copy the values from the deployment record into the API environment:

```bash
EVM_CHAIN_ID=84532
EVM_RPC_URL=...
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
CAMPAIGN_MANAGER_ADDRESS=<campaignManager>
CAMPAIGN_MANAGER_DEPLOY_BLOCK=<deployBlock>
```

With the public RPC (`https://sepolia.base.org`), also set `INDEXER_MAX_BLOCK_RANGE=200`: it rejects `eth_getLogs` over more than 200 blocks with HTTP 413.

On startup the API refuses to run if the configuration is partial, the chain is unsupported (Base mainnet is intentionally unsupported), the USDC address is not the official one, the RPC reports another chain, or either contract has no code.

## ABI

`packages/shared/src/contracts/campaign-manager-abi.ts` is generated from `forge build` by `packages/contracts/scripts/export-abi.mjs`. CI fails if it drifts from the compiled contract:

```bash
cd packages/contracts && forge build && node scripts/export-abi.mjs
```
