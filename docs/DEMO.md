# Demo: the full flow on a local chain

[English](DEMO.md) | [繁體中文](DEMO.zh-TW.md)

This guide runs the whole economic loop on your machine, first as one scripted test and then by hand in a browser. It also records the Base Sepolia run of 2026-10-14.

The demo uses a real local chain (anvil), the compiled `CampaignManager` contract, a real PostgreSQL database and the real API:

```text
Advertiser signs in with Ethereum → creates a draft campaign with a comprehension check
→ createCampaign on-chain → the API verifies the transaction and links the draft
→ approve + fundCampaign → the indexer confirms it and the campaign becomes active
→ participant passes World ID (simulated) → answers the check
→ the backend signs an EIP-712 authorization → the participant claims 1 USDC on-chain
→ a second claim is refused by the contract → the API's figures match the chain
→ the advertiser closes the campaign (no new liability after that)
→ after the waiting period, refunds the unused budget
→ analytics show "settled" and every amount adds up
```

Only **World ID** is simulated locally, because a real proof needs the World App and a Developer Portal app. The local USDC is a mock token.

The amounts depend on the run. The scripted test funds 10 USDC, pays two participants (the second is accepted before the close and claims after it) and refunds 8 USDC. The browser demo, with one participant, refunds 9 USDC.

Contents:

- [Tools](#tools)
- [Scripted demo: the end-to-end test](#scripted-demo-the-end-to-end-test) (a few minutes)
- [Browser demo: advertiser and participant pages](#browser-demo-advertiser-and-participant-pages) (about 15 minutes, plus the wait for the start time)
- [With a real World ID](#with-a-real-world-id)
- [Base Sepolia](#base-sepolia), with [the run of 2026-10-14](#the-base-sepolia-run-of-2026-10-14)
- [Other commands](#other-commands)
- [How the advertiser page handles slow or replaced transactions](#how-the-advertiser-page-handles-slow-or-replaced-transactions)
- [API quick reference](#api-quick-reference)

---

## Tools

| Tool | Version | Note |
| --- | --- | --- |
| Node.js | 24.15 or newer | |
| pnpm | 12.4.2 | `corepack enable` picks the version in `packageManager` |
| Foundry (forge, anvil, cast) | v1.8.4 | On Windows, install it inside WSL |
| PostgreSQL | 16 or newer | Docker is the simplest way; a native install works too |

---

## Scripted demo: the end-to-end test

This runs the loop above as one test, with no browser. The test adds a second participant and failure drills: a lost RPC response, a resend of the same draft, a pause and a signer rotation. CI runs the same test on every push and pull request (the `e2e` job in `.github/workflows/ci.yml`).

### macOS, Linux or WSL

Use three terminals.

**Terminal 1: PostgreSQL**

```bash
docker run --rm --name vham-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=vham_e2e \
  postgres:16-alpine
```

**Terminal 2: local chain**

```bash
anvil
```

**Terminal 3: build the contract and run the test**

```bash
pnpm install
(cd packages/contracts && forge build)

export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/vham_e2e
export E2E_RPC_URL=http://127.0.0.1:8545
pnpm --filter @vham/api test:e2e
```

### Windows (PowerShell, with Foundry in WSL)

- **PostgreSQL:** run the `docker run` command above on one line in Docker Desktop's terminal, or use any PostgreSQL you can reach and put its URL in `TEST_DATABASE_URL`.
- **anvil:** run `anvil` in a WSL terminal. WSL2 forwards `127.0.0.1:8545` to Windows.
- **Contract:** run `cd packages/contracts && forge build` in WSL. The `out/` folder it writes is inside the repository, so Windows sees it.

Then, in PowerShell:

```powershell
pnpm install
$env:TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/vham_e2e"
$env:E2E_RPC_URL = "http://127.0.0.1:8545"
pnpm --filter @vham/api test:e2e
```

### Expected result

```text
 ✓ e2e/poc.e2e.ts (1 test)
   ✓ POC economic loop on a local chain (1)
     ✓ runs create → fund → verify → claim → close → refund with matching accounting

 Test Files  1 passed (1)
      Tests  1 passed (1)
```

- Each run empties the tables of the `vham_e2e` database. Use a database kept for this, **not** your development database.
- The test moves anvil's clock forward. Restart anvil before you run it again.
- Without `TEST_DATABASE_URL` the test is skipped, not failed.
- Without `forge build` the test cannot read the contract from `packages/contracts/out/`.

---

## Browser demo: advertiser and participant pages

Here you act as the advertiser and as the participant with a browser wallet: the advertiser creates and funds a campaign, the participant answers and claims. World ID is simulated: `WORLD_ID_MODE=simulated` works only on a local anvil chain (chain 31337), and the API refuses to start with it on any other chain.

The accounts below are the **public test accounts** anvil prints when it starts. Everyone knows their private keys. Use them only on your machine and never on a real network.

| Role | Account | Address | Private key |
| --- | --- | --- | --- |
| Deployer | anvil #0 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | in the deploy command below |
| Claim signer | anvil #1 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | in the environment block below |
| Advertiser (import into the browser wallet) | anvil #2 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` |
| Participant (import as a second account) | anvil #3 | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` | `0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6` |

### Start the services

```bash
# Terminal 1: the database. Stop the scripted demo's container first (it has the same name and port),
# then use the same docker run with POSTGRES_DB=vham
# Terminal 2: local chain. A block every 2 seconds gives the indexer confirmations to wait for
anvil --block-time 2

# Terminal 3: deploy mock USDC and CampaignManager, and give the advertiser 100 mock USDC
cd packages/contracts && forge build
CLAIM_SIGNER_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
ADVERTISER_ADDRESS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC \
forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
cat deployments/31337.json      # note campaignManager, usdc and deployBlock
```

Environment variables for the API and the indexer (for example in `.env` in the repository root, which must **not** be committed):

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/vham
EVM_CHAIN_ID=31337
EVM_RPC_URL=http://127.0.0.1:8545
USDC_ADDRESS=<usdc from deployments/31337.json>
CAMPAIGN_MANAGER_ADDRESS=<campaignManager>
CAMPAIGN_MANAGER_DEPLOY_BLOCK=<deployBlock>
CLAIM_SIGNER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
SIWE_DOMAIN=localhost:3000
WORLD_ID_MODE=simulated
PARTICIPANT_KEY_SECRET=local-demo-secret-at-least-32-characters
INDEXER_CONFIRMATIONS=2
# Local demo: campaigns of anvil #2 pass moderation at once (MODERATION_MODE=open also works)
ADVERTISER_ALLOWLIST=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
```

Run terminals 4 to 6 from the repository root. The API and the indexer do not read `.env` by themselves. Load it in terminals 4 and 5 first: `set -a; source .env; set +a` in bash or zsh, or one `$env:NAME = "value"` line per variable in PowerShell.

```bash
# Terminal 4: API (runs the migrations first)
pnpm --filter @vham/api db:migrate && pnpm --filter @vham/api dev
# Terminal 5: indexer
pnpm --filter @vham/api indexer
# Terminal 6: web app
API_URL=http://localhost:3001 NEXT_PUBLIC_CHAIN_ID=31337 pnpm --filter @vham/web dev
```

On Windows, run terminals 2 and 3 in WSL and the rest in PowerShell. Windows PowerShell 5.1 has no `&&`, and PowerShell has no `NAME=value command` form, so run `pnpm --filter @vham/api db:migrate` and `pnpm --filter @vham/api dev` one after the other, and for terminal 6 set `$env:API_URL = "http://localhost:3001"` and `$env:NEXT_PUBLIC_CHAIN_ID = "31337"` before `pnpm --filter @vham/web dev`.

### Click through it

In the browser wallet, add the network (RPC `http://127.0.0.1:8545`, chain ID `31337`, currency symbol `ETH`) and import the two accounts from the table above. Two browser profiles, each with its own wallet extension, are the safest: one for the advertiser and one for the participant. Both pages run on `localhost:3000`, and a page reads the wallet's account once, when you press **Connect wallet**. With a single extension, reload the page after you switch accounts and check the address it shows.

1. **Advertiser (anvil #2):** open <http://localhost:3000/advertiser>, press **Connect wallet**, then **Sign in with Ethereum**. Fill in the form:
   - **Sponsored content URL:** any public `https` address, for example `https://example.com/`. The form accepts only `https`, and the API refuses IP addresses, internal hostnames such as `localhost`, and addresses with a port.
   - **Reward per completion** and **Max completions:** keep the defaults, `1` and `10`, for a budget of 10 USDC.
   - **End:** at least 15 minutes after the start and at most 24 hours after it. The default works.
   - One question, its choices, and which choice is correct.
   - **Start:** fill this in last, 3 to 5 minutes from now. The default is 15 minutes from now, and nobody can answer before the start. The start must still be ahead when **Create on-chain** is mined. If the page says "The start time has passed; create a new campaign with a later start.", open <http://localhost:3000/advertiser> again and make a new draft.

   Press **Save draft**, then **Create on-chain**, then **Approve & fund** (the wallet asks for two transactions: the approval and the funding). When the status is `active`, copy the participant link from the page.
2. **Wait for the start time.** The local chain follows the real clock.
3. **Participant (anvil #3):** open the participant link in the participant's profile (with a single extension, switch to the second account first). Press **Connect wallet**, then **Verify with World ID** (simulated locally: no widget opens and it passes). Open the content, choose an answer and press **Submit answers**, then press **Claim USDC**. The wallet receives 1 mock USDC and the page shows "Reward paid to your wallet." with the transaction hash.
4. Back on the advertiser page, the paid amount and the completion count have changed. A participant who submits less than 15 seconds after verifying is still paid, and the page lists that completion under `FAST_COMPLETION` and leaves it out of "Quality-adjusted accepted".
5. **Advertiser (anvil #2):** on the advertiser page, with the advertiser's account connected, press **Close campaign**. **Refund unused budget** appears about 15 minutes later (the page counts down), because authorizations that were already issued stay valid for up to 15 minutes. Press it and the status becomes `settled`. To skip the wait, run `cast rpc anvil_increaseTime 900 && cast rpc anvil_mine`; the button appears the next time the page reads the chain (within 10 seconds).

The session cookie is `HttpOnly` and `Secure` (#72). Chromium keeps such a cookie for `http://localhost` and `http://127.0.0.1`; other browsers were not checked. If the browser drops it, signing in says why: use Chromium, or `next dev --experimental-https`.

### Running it again

anvil starts a new chain every time, and the deploy script puts the contracts at the same addresses on it. A database that still holds the previous chain no longer matches: the indexer logs `Inconsistent chain read at block N; retrying`, and new campaigns never become `active`. After `anvil_increaseTime` the chain's clock is also ahead of the real one, so restart anvil after using it. Before another round:

1. Stop the API and the indexer, and restart anvil.
2. Recreate the database: stop and start the PostgreSQL container again (`--rm` drops its data), or drop and create the `vham` database.
3. Run the deploy command again and check that `deployments/31337.json` still matches the addresses and the deploy block in your environment.
4. Run the migrations and start the API, the indexer and the web app again.
5. The wallet still remembers the old chain's transaction counts. Clear its activity data for this network (in MetaMask: Settings → Advanced → Clear activity tab data).

---

## With a real World ID

The local demo simulates World ID. A real proof needs the World App (or the official simulator or sandbox) and an app in the Developer Portal. These steps follow the official documentation as checked on 2026-10-13 (<https://docs.world.org/world-id/idkit/integrate>, <https://docs.world.org/world-id/idkit/signatures>):

1. Create an app in the [Developer Portal](https://developer.world.org) and complete the World ID 4.0 RP registration. It gives you an `app_id`, an `rp_id` and a `signing_key`.
2. Configure the API. These go only in the API's environment, **never** in a commit and never in a `NEXT_PUBLIC_*` variable:

   | Variable | Meaning |
   | --- | --- |
   | `WORLD_ID_APP_ID` | `app_…`, returned to the web app so that it can open the widget |
   | `WORLD_ID_RP_ID` | `rp_` followed by 1 to 16 hex digits; used to sign requests and to call `POST /api/v4/verify/{rp_id}` |
   | `RP_SIGNING_KEY` | The RP signing key (32 bytes, hex). It signs `rp_context` on the server only and is a secret |
   | `WORLD_ID_ENVIRONMENT` | `production` (the default) or `staging` (for the simulator). The same value goes to the widget, and the backend refuses a proof from the other environment |
   | `PARTICIPANT_KEY_SECRET` | At least 32 characters. Without it, eligibility verification answers 503 |

   `WORLD_ID_MODE` must be `live` (the default), with `WORLD_ID_RP_ID`, `RP_SIGNING_KEY` and `WORLD_ID_APP_ID` all set. With none of the three set, `world-id/request` answers `503 WORLD_ID_NOT_CONFIGURED`. With only some of them set, or with a malformed id or key, the API fails at startup (`loadWorldIdConfig`). `simulated` mode works only on anvil; there `world-id/request` returns `mode: "simulated"` and the action, with no `appId` and no `rp_context`.

3. The web app has no World ID mode of its own; it follows the `mode` that `world-id/request` returns. When the participant presses **Verify with World ID**, the web app gets `rp_context` from the API, generates a random 32-byte salt in the browser, computes the signal bound to this wallet (`@vham/shared/world-id`), and opens the IDKit widget. It sends IDKit's result unchanged to `eligibility/verify`, with the wallet address and the salt. Another wallet or another salt gets `403 SIGNAL_MISMATCH`. The API accepts only the `proof_of_human` credential (`issuer_schema_id` 1). The salt stays in the browser's memory; the API neither stores nor logs it.
4. Each campaign uses the action `vham-campaign-<id>`. The official documentation does not require registering an action in the portal first (see ADR-0007), and the Base Sepolia run below confirmed that.
5. Rotating `RP_SIGNING_KEY` affects only requests signed afterwards. Rotating `PARTICIPANT_KEY_SECRET` breaks duplicate detection for running campaigns, so do it only between campaigns.

---

## Base Sepolia

**No public deployment matches the current code.** The contract deployed on 2026-10-14 is from before ADR-0011, and the API refuses to start against it (`campaignIdByDraft` reverts). To see the whole flow today, use the local demos above. To deploy the current contract, follow [`docs/deployment/TESTNET.md`](deployment/TESTNET.md); the re-run is described in [`docs/deployment/BASE_SEPOLIA_RERUN.md`](deployment/BASE_SEPOLIA_RERUN.md).

### The Base Sepolia run of 2026-10-14

The whole flow ran once on Base Sepolia (#13) with a real World ID proof (production environment, an Orb-verified World App), the `CampaignManager` contract and Circle's test USDC. Every step succeeded.

> This run used the v1 contract, from before ADR-0011. Its deployment record is in `packages/contracts/deployments/archive/`. The current contract, whose `createCampaign` takes a `draftRef`, has to be deployed and run again.

| Item | Value |
| --- | --- |
| `CampaignManager` | [`0x12cc9447CEb3f8E75dDf4463A1A4D9feB42bDFEc`](https://sepolia.basescan.org/address/0x12cc9447CEb3f8E75dDf4463A1A4D9feB42bDFEc) (v1; record archived in `packages/contracts/deployments/archive/84532-2026-10-14-pre-adr-0011.json`) |
| Campaign | on-chain ID `1`; 1 USDC × at most 3 completions; funded with 3 USDC |
| World ID | `production`, action `vham-campaign-<campaignId>`, the `proofOfHuman()` preset. This was the setting before the #74 fix: the preset still allowed 3.0 proofs, and `CredentialRequest("proof_of_human")` replaced it (ADR-0007) |

| Step | Result | Transaction / block |
| --- | --- | --- |
| Deploy | Owner, signer, USDC and contract code read back from the chain | [`0x2903d8ac…cdc90338`](https://sepolia.basescan.org/tx/0x2903d8ac3ae70c06441cc34f915fe9be0681b75050a683b9ec643529cdc90338) / 48106357 |
| Create campaign | The API verified it and linked on-chain ID 1 | [`0x2042fdcc…629f0b39`](https://sepolia.basescan.org/tx/0x2042fdcc6c7de3b14df89d4f6fb1c25df4814a87e95f3f8db606879d629f0b39) / 48107249 |
| Fund | Status `active` once the indexer confirmed it | [`0xda1673ce…8a3bea65`](https://sepolia.basescan.org/tx/0xda1673ced0c7b3c6bf6345d34339e49d86b33060f903168df53571508a3bea65) / 48107268 |
| World ID verification | A real proof passed the backend's v4 verification, and one eligibility row was written | — |
| Answer | A submission before the start time was refused with `CAMPAIGN_NOT_STARTED`, as intended; it passed after the start | — |
| Claim | The participant received 1 USDC | [`0xc929552c…4bf876d7`](https://sepolia.basescan.org/tx/0xc929552ca98dc923a18baf04b4d2c47b0b05b1c91093444eafa77a854bf876d7) / 48107877 |
| Close | Status `closed` | [`0x3bdfb614…65914ae5`](https://sepolia.basescan.org/tx/0x3bdfb614d99bbc5673469648424fc43ff72d2d32c9b22c10867a2fab65914ae5) / 48107965 |
| Refund | 2 USDC returned 15 minutes after the close; contract balance 0; status `settled` | [`0x242c6aac…1c5e44a4`](https://sepolia.basescan.org/tx/0x242c6aac019183f29a18c12e39ba2380a94ad2e9f4bf573662831da41c5e44a4) / 48108562 |

What the run showed:

- **A per-campaign action needs no registration.** No action was created in the Developer Portal, and `vham-campaign-<id>` still verified (ADR-0007 was updated).
- **The public RPC answers `eth_getLogs` for at most 200 blocks.** With `https://sepolia.base.org`, set `INDEXER_MAX_BLOCK_RANGE=200`, or the indexer keeps getting HTTP 413.
- The first QR scan showed the World App's "Verification unavailable"; scanning another way worked. The API received no request, so it was not a backend setting.
- The web app had no close and refund buttons then, so the advertiser signed both with `cast send ... --interactive`. The buttons exist now.
- When another container holds port 5432, PostgreSQL can use another port; change `DATABASE_URL` to match.

---

## Other commands

The checks to run before a commit are in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

### PostgreSQL integration tests only

```bash
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/vham_e2e
pnpm --filter @vham/api exec vitest run postgres
```

These tests also empty the tables of that database.

### API and indexer against a deployed contract

```bash
cp .env.example .env    # fill it in as its comments say; do not commit .env
set -a; source .env; set +a        # load .env; the API and the indexer do not read it themselves
pnpm --filter @vham/api db:migrate
pnpm --filter @vham/api dev        # API, http://localhost:3001 by default
pnpm --filter @vham/api indexer    # in another terminal (load .env there too): event indexing and campaign status
```

The API and the indexer read settings only from environment variables. Without `DATABASE_URL` in the shell, `db:migrate` fails at once (`DATABASE_URL is required for migrations`). Load the variables in every terminal that runs the API or the indexer.

What each group of variables does:

- **Chain** (`EVM_RPC_URL`, `USDC_ADDRESS`, `CAMPAIGN_MANAGER_ADDRESS`, `CAMPAIGN_MANAGER_DEPLOY_BLOCK`): set all of them or none. At startup the API checks the chain ID and the contract code.
- **`SIWE_DOMAIN`**: without it nobody can sign in, and every advertiser endpoint answers 401.
- **`WORLD_ID_RP_ID` + `RP_SIGNING_KEY` + `WORLD_ID_APP_ID` + `PARTICIPANT_KEY_SECRET`**: set the first three together. With none of them, eligibility verification answers 503; with only some, or a malformed value, the API refuses to start.
- **`CLAIM_SIGNER_PRIVATE_KEY`** (or, in production, `CLAIM_SIGNER_URL` + `CLAIM_SIGNER_ADDRESS`, ADR-0008): without it no authorization is signed. The signer's address must equal the contract's `authorizedSigner` and must not be the deployer's key. A plain private key is allowed only on anvil and Base Sepolia.
- **Moderation (#24)**: the default is `MODERATION_MODE=review`. A wallet in `OPERATOR_ADDRESSES` has to approve a new campaign before it can be published and answered, unless the advertiser is in `ADVERTISER_ALLOWLIST`. `MODERATION_MODE=open` works only on a local anvil chain. See [docs/operations/MODERATION.md](operations/MODERATION.md).

### Advertiser web app

```bash
# API side (.env): SIWE_DOMAIN must equal the host of the web app's address
SIWE_DOMAIN=localhost:3000

# Web app
export API_URL=http://localhost:3001        # Next forwards /api/* to it
export NEXT_PUBLIC_CHAIN_ID=84532           # 31337 for a local anvil chain
pnpm --filter @vham/web dev                 # http://localhost:3000/advertiser
```

What the page does (#11):

1. Connect a browser wallet. On the wrong network the page shows a switch button.
2. Sign in with Ethereum. The session survives a reload; with no wallet connected the page shows "Signed in as …" and "Sign out". "Disconnect" signs out first and then disconnects the wallet; if signing out fails, both stay and you can press it again.
3. Fill in the campaign (the reward is entered as decimal USDC and converted to integer atomic units) with 1 to 3 comprehension questions, and press "Save draft".
4. Press "Create on-chain" to send `createCampaign`. The API verifies the transaction and links the draft.
5. Press "Approve & fund" to approve and fund. When the wallet's USDC allowance for CampaignManager already covers the budget, the button reads "Fund campaign" and sends only the funding.
6. Once the indexer confirms the funding, the status becomes `active` and the page shows the budget and the results.
7. Press "Close campaign" to end early. After the close the API issues no new authorization; one that was already issued can still be claimed on-chain until it expires. The button is not offered in the last minute before the end, because the transaction could land after the end and revert.
8. The refund opens 15 minutes after the close (or after the end, if the campaign was never closed): an issued authorization stays valid for up to 15 minutes, and the contract waits until all of them have expired. Until then the page shows the opening time, a countdown and the reason. Then press "Refund unused budget": the status becomes `settled` and the unused budget returns to the advertiser's wallet.

---

## How the advertiser page handles slow or replaced transactions

When the owner has paused the contract, the page says that the refund has to wait for the unpause; "Close campaign" is not affected by a pause. Before sending, both buttons read the chain again and simulate the transaction. When the contract refuses it, the page shows the custom error's name (for example `RefundNotAvailable`) and does not resend.

**Close and refund (#86).** When the transaction has no receipt within the wait (2 minutes), the card says "still confirming" and the button is hidden. Every 10 seconds the page checks the receipt, the wallet account's nonce and the campaign's status, with no reload needed:

- When the receipt arrives, or the chain already shows the action's result (`closed` after a close, `settled` after a refund; for example a replacement finished it after a speed-up in the wallet), the card becomes done and the buttons follow the chain.
- When the receipt shows a revert, or another transaction used the same nonce (a cancel in the wallet), and the campaign read again is unchanged, the card gives the reason and the button comes back if the chain still allows the action.
- Different backends may answer the wallet's RPC, so a conclusion counts only when two checks in a row agree. If the chain later shows the action's result after all, a card that said failed becomes done.
- A transaction that was found at least once (its nonce is known) counts as still confirming until that nonce is used, because it can land at any time. A transaction that was never found and is still missing after 10 minutes may never have been sent: the normal button stays hidden, and the page offers a separate "Close campaign anyway" or "Refund unused budget anyway" with a warning. Look at the wallet's activity first. The resend is simulated too: if the original landed, the simulation fails and nothing is sent; if neither has landed, the second one only reverts and costs gas.

**Approve and fund (#103).** The approval (Approve USDC) and the funding (Fund campaign) follow the same rules: the card says "still confirming", the funding button is hidden, and every 10 seconds the page checks the receipt, the nonce and the result the transaction should produce, with no reload needed.

- The approval's result is an allowance (owner: the advertiser; spender: CampaignManager) that covers the budget, which is rewardPerCompletion × maxCompletions in atomic units, computed with integers. Once the page sees it, the card becomes done and the button reads "Fund campaign". The funding is sent only when you press it; the page never sends it by itself.
- The button comes back as soon as the approval's receipt arrives, even when a later check finds it, without waiting for the allowance to cover the budget. A wallet has one allowance for CampaignManager, so an approval or a funding in another tab, or a lower spending cap set in the wallet, can leave it below the budget. Then the button reads "Approve & fund", and pressing it reads the allowance again and approves only if it is still short.
- The funding's result is a campaign that is `active` on-chain with `fundedBudget` equal to the budget, or funding that the API's index has seen. After the funding is sent, the button stays hidden until the page sees that result. Once the page has seen the campaign funded, it offers neither approval nor funding again, even when a later read (perhaps from a lagging RPC backend) shows it unfunded.
- A revert, a replacement, two agreeing checks, a failed card that later becomes done, and "Approve & fund anyway" or "Fund campaign anyway" after 10 minutes for a transaction that was never found all work as they do for close and refund. The exception is a reverted approval: the allowance can also come from another campaign's approval, so that card does not turn into "USDC approved" later.
- The page reads the chain again before every send, including the moment the approval is done and the funding is about to go (the approval may have waited two minutes). When the original funding has landed after all, or the allowance was changed to below the budget, the page says why and sends nothing. Two approvals that both land only set the allowance twice and cost gas. When two fundings are sent, the contract refuses the second with `InvalidCampaignStatus` and it costs gas; the USDC is not taken twice.
- While the page waits for the funding, every refresh reads the allowance and the campaign to decide whether the button reads "Approve & fund" or "Fund campaign".

While one action is in progress, the other buttons (including "Close campaign" and "Refund unused budget") are disabled, not removed, so a repeated click cannot land on a "Refresh" that slid into the same place.

The close and refund buttons appear only for a campaign on the contract that is deployed now (`GET /v1/chain`). For a campaign on the contract from before ADR-0011 the page has no contract address to use; the advertiser's wallet still has to send `closeCampaign(id)` and `refundUnusedBudget(id)` with `cast send`.

**Create.** When the creation transaction has no receipt for a long time, the page says "still confirming, do not resend" and keeps reconciling with the API: by the transaction hash while the page has it, and by `draftRef` otherwise. An API that cannot reach the chain for a moment (`503 RPC_UNAVAILABLE`) also counts as still reconciling, and the page retries by itself for about two minutes. When it gives up, the card states the reason and asks you to press "Check again", which only queries and sends no transaction. After a reload the page no longer has the transaction hash; it remembers only that a creation may have been sent for this draft, so it offers "Check again" first. "Create on-chain anyway" is offered only after 10 minutes. If the original transaction landed after all, the second one reverts with `DraftAlreadyCreated` and costs gas; it does not create a second campaign.

Edge cases of "a creation may be unconfirmed" (#78):

- When a creation from another tab or browser is mined but below the confirmation depth, `/publish` decides from the latest block and answers `409 DRAFT_ALREADY_CREATED`, so this tab does not send another; the page waits for the confirmation and then links it. While that transaction is in the mempool and not mined, the API cannot see it, and only the contract stops the second one (it reverts and costs gas).
- When the browser has no `localStorage` (for example in private browsing), the marker lives only in this tab's memory: "Check again" and, after 10 minutes, "Create on-chain anyway" appear as usual during the visit, and a reload forgets it. The page then offers "Create on-chain" directly; before sending it still looks for a confirmed creation, and `/publish` checks the latest block.
- When you press "Create on-chain anyway" and then reject the signature in the wallet, nothing was sent this time. The marker of the earlier attempt stays, and the page goes on offering "Check again".

---

## API quick reference

| Step | Endpoint | Called by |
| --- | --- | --- |
| Sign in | `POST /v1/auth/nonce` → the wallet signs the SIWE message → `POST /v1/auth/verify` | Advertiser |
| Create a draft | `POST /v1/campaigns` (`Authorization: Bearer …`, `Idempotency-Key`) | Advertiser |
| Moderate | `POST /v1/admin/campaigns/:id/moderation { action: "approve", reason }` | Operator |
| Chain settings | `GET /v1/chain` | Anyone |
| Get the on-chain parameters | `POST /v1/campaigns/:id/publish` (the campaign must be approved) | Advertiser |
| Report or link the creation | `POST /v1/campaigns/:id/onchain { txHash }`, or `{}` to look up the creation by `draftRef` | Advertiser |
| Mission content | `GET /v1/campaigns/:id/mission` | Participant |
| World ID request | `POST /v1/campaigns/:id/world-id/request` | Participant |
| Eligibility | `POST /v1/campaigns/:id/eligibility/verify { claimant, signalSalt, idkitResponse }` | Participant |
| Answer | `POST /v1/campaigns/:id/submissions` (`Idempotency-Key`) | Participant |
| Claim authorization | `POST /v1/campaigns/:id/submissions/:submissionId/authorization` | Participant |
| Claim on-chain | `CampaignManager.claim(authorization, signature)`, sent by the participant's wallet | Participant |
| Results | `GET /v1/campaigns/:id/analytics` | Advertiser |
| Report a campaign | `POST /v1/campaigns/:id/reports { reason, details? }` | Anyone |

The full specification is in [`docs/architecture/API_SPEC.md`](architecture/API_SPEC.md).
