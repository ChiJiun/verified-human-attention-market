# How to redeploy CampaignManager and re-run the POC on Base Sepolia

> Issues #12 and #13, ADR-0011. The external facts and the retired contract were last checked on **2026-10-20**. Repeat both checks on the day of the run (steps 1 and 2).

This runbook deploys the ADR-0011 `CampaignManager` to Base Sepolia, moves the API and its database to it, and runs the POC end to end in the web app. Campaign 1 runs the main flow. Campaign 2 shows that a closed campaign refuses a completion. Each step says what you should see and what to record. The [table at the end](#acceptance-criteria-and-the-steps-that-prove-them) maps every acceptance criterion of #12 and #13 to the step that proves it.

Two additions are optional: a campaign 2 that expires instead of closing, and screenshots from a real phone. Each is marked **Optional**.

Plan for about 90 minutes. A refund opens when a block timestamp is more than 900 seconds after the campaign's `closedAt`, or after its `endTime` if nobody closed it. The advertiser page shows the first such second, 901 seconds after that time.

## Who does what

The owner does every step that needs a key, a password, or the phone. Nobody else can do these steps:

- the deploy, which signs with the Foundry keystore `deployer` and asks for its password;
- every wallet signature: the advertiser's sign-in, create, approve, fund, close, and refund, and participant wallet A's claim;
- every World App scan.

The operator runs the services, the database commands, and the read-only checks, with the `.env` that the owner provides. The operator needs no wallet key. One person can do both roles. Steps for the owner say **(owner)**.

Run `forge` and `cast` in WSL, where Foundry is installed. The commands use bash syntax. [DEMO.md](../DEMO.md) shows how to load `.env` in bash and in PowerShell. The `cast` commands reuse `EVM_RPC_URL` and `USDC` from step 2 and `CM` from step 7, so run them in one WSL terminal.

## Before you start

The run needs all of the following:

- These changes merged on `main`, with green CI on the commit you deploy from:
  - PR #62, the ADR-0011 contract, after the owner's review. This contract is what you deploy.
  - The fix that makes the API accept only World ID 4.0 proofs and the web app request a 4.0 `proof_of_human` credential with legacy proofs off.
  - The #71 change, which binds each proof to the claimant wallet through a server-derived signal and refuses a mismatch with `SIGNAL_MISMATCH`.
  - The #69 change, which adds the **Close campaign** and **Refund unused budget** buttons to the advertiser page.
  - The #72 change (session cookie and CSP) is optional. The checks marked "If #72 is merged" cover it.
- A checkout of that commit, after `pnpm install`, which also builds `@vham/shared`.
- These wallets on Base Sepolia:

  | Wallet                                                              | Needs                    | Used for                                                           |
  | ------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------ |
  | `deployer`, a Foundry keystore in WSL (`cast wallet list` shows it) | test ETH                 | the deploy                                                         |
  | advertiser                                                          | test ETH and 3 test USDC | two campaigns                                                      |
  | participant A                                                       | test ETH                 | the claim                                                          |
  | participant B, a second account in the participants' browser wallet | nothing                  | negative checks only; it never sends a transaction                 |
  | claim signer (`CLAIM_SIGNER_PRIVATE_KEY`)                           | nothing                  | claim signatures; never the deployer key ([Keys](TESTNET.md#keys)) |

- Test USDC from Circle's faucet (https://faucet.circle.com, select **Base Sepolia**) and test ETH from a [Base network faucet](https://docs.base.org/base-chain/network-information/network-faucets).
- The Developer Portal app with its World ID 4.0 RP registration (`WORLD_ID_APP_ID`, `WORLD_ID_RP_ID`, `RP_SIGNING_KEY`), and World App on the owner's phone.
- Two browser profiles, each with its own wallet extension: one for the advertiser wallet, one for participant wallets A and B. Both pages run on `localhost:3000`, so a single extension would sign for whichever account is selected.
- Chrome or Firefox for the advertiser profile. With the #72 change, the session cookie is `__Host-vham_session` with `Secure` and `SameSite=Strict`. Chrome and Firefox keep a `Secure` cookie that `http://localhost` sets. Safari drops it, so the page cannot keep the sign-in.

### Record evidence as you go

Record the evidence in a new section of [DEMO.md](../DEMO.md), in the table format of the 2026-10-14 run:

- the hash and block of every transaction;
- the HTTP status and error code of every refusal;
- the analytics fields of step 30 and the reconciliation report of step 31;
- the World ID `protocol_version` of every scan;
- every screenshot, labeled **emulation** or **real phone**.

To read a transaction's block, use the explorer or `cast receipt <hash> blockNumber --rpc-url "$EVM_RPC_URL"`.

Never record the World ID proof, nullifier, signal, or `signal_hash`, the eligibility token, the `rp_context`, a value from `.env`, or an RPC URL that carries an API key.

### Wait for the status after a transaction

The wallet reports a transaction as soon as it is mined. The `status` field on the advertiser page comes from the API, which follows the indexer, so it changes later. The indexer treats an event as final once `INDEXER_CONFIRMATIONS` newer blocks follow it (default 10). That takes about 20 seconds on Base Sepolia, which mines a block every 2 seconds. The indexer then picks the event up on its next pass, which runs every `INDEXER_POLL_MS` milliseconds (default 5000), and the page reads the API every 10 seconds. Allow a minute between the receipt and the new status.

## Check the facts and the old contract

1. Re-check the external facts (AGENTS.md §19). Open each source and compare. If a value differs, stop and update [TESTNET.md](TESTNET.md) first.

   | Fact                  | Value on 2026-10-20                                                                                                                                                              | Source                                                                                                                         |
   | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
   | Base Sepolia chain ID | `84532`                                                                                                                                                                          | [Connecting to Base](https://docs.base.org/base-chain/quickstart/connecting-to-base)                                           |
   | Public RPC            | `https://sepolia.base.org`                                                                                                                                                       | same                                                                                                                           |
   | Explorer              | https://sepolia.basescan.org                                                                                                                                                     | same                                                                                                                           |
   | Test USDC (Circle)    | `0x036CbD53842c5426634e7929541eC2318f3dCF7e`                                                                                                                                     | [USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)                                   |
   | World ID verify       | `POST https://developer.world.org/api/v4/verify/{rp_id}`. The request's `protocol_version` is `3.0` or `4.0`. The response does not repeat it.                                   | [Verify reference](https://docs.world.org/api-reference/developer-portal/verify)                                               |
   | Legacy proofs         | `allow_legacy_proofs: false` asks for 4.0 proofs only. The `proofOfHuman` preset includes a legacy Orb fallback.                                                                 | [Credentials](https://docs.world.org/world-id/idkit/credentials)                                                               |
   | Signal                | Binds app context such as a wallet address, and the backend has to check the same value. A 4.0 result without a signal has `signal_hash` `0x0`.                                  | [Credentials](https://docs.world.org/world-id/idkit/credentials), [Integrate](https://docs.world.org/world-id/idkit/integrate) |
   | RP signature          | EIP-191 over `0x01`, the nonce, `created_at`, `expires_at`, and `hash_to_field(action)`, with a default TTL of 300 s. It covers neither the signal nor the requested credential. | [RP signatures](https://docs.world.org/world-id/idkit/signatures)                                                              |

   Since the 2026-10-13 check:

   - The Base and Circle values are unchanged.
   - The credentials page, which the 2026-10-13 check did not use, says that the `proofOfHuman` preset falls back to legacy Orb proofs. The 2026-10-14 run used that preset, so its proof may have been 3.0. The 4.0-only fix requests `CredentialRequest("proof_of_human")` with legacy proofs off instead.
   - The pages above show `CredentialRequest` only with session proofs (`CredentialRequest("selfie")`) and do not list `proof_of_human`. The IDKit 4.4.0 package defines `proof_of_human` (issuer schema ID 1) and a per-credential `signal`, so step 15 is the first live check of that request.
   - The [4.0 migration guide](https://docs.world.org/world-id/4-0-migration) tells apps to create v4 actions in the Developer Portal. The finding that per-campaign actions need no registration (ADR-0007) comes from the 2026-10-14 run, whose protocol version nobody recorded.
   - The verify reference lists a `sandbox` environment next to `production` and `staging`. The API accepts only `production` and `staging`, and this run uses `production`.

2. Confirm that the old contract owes nothing. [TESTNET.md](TESTNET.md#moving-to-a-new-campaignmanager) allows the switch only when every campaign on the old contract is settled or cancelled. Every `cast` command in this runbook reads the RPC from `EVM_RPC_URL`, the name that `.env` uses. Set it to the public RPC unless you loaded `.env` in this terminal. Then read the contract:

   ```bash
   EVM_RPC_URL=${EVM_RPC_URL:-https://sepolia.base.org}
   OLD=0x12cc9447CEb3f8E75dDf4463A1A4D9feB42bDFEc
   USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e
   cast call $OLD "campaignCount()(uint256)" --rpc-url "$EVM_RPC_URL"
   cast call $OLD "campaigns(uint256)(address,uint128,uint128,uint96,uint32,uint32,uint64,uint64,uint64,uint8)" 1 --rpc-url "$EVM_RPC_URL"
   cast call $USDC "balanceOf(address)(uint256)" $OLD --rpc-url "$EVM_RPC_URL"
   ```

   Repeat the second call for every id up to `campaignCount`. The last field of `campaigns(id)` is the stored status, where `4` is `Settled` and `5` is `Cancelled`. The contract's USDC balance must be `0`.

   On 2026-10-20 at block 48364402, `campaignCount` was 1. Campaign 1 had status 4, with 3000000 funded and 1000000 paid, and it closed on 2026-10-14 at 13:23:38 UTC. The contract held 0 test USDC, and the 2000000 refund is the `CampaignRefunded` log at block 48108562. The on-chain half of the condition holds.

   Then run the SQL query in [Moving to a new CampaignManager](TESTNET.md#moving-to-a-new-campaignmanager) against the current database. It must return no rows.

## Deploy and switch the API

3. Stop the API and the indexer worker if they run (TESTNET.md step 1).
4. Back up the database:

   ```bash
   mkdir -p "$HOME/vham-rerun"
   pg_dump --format=custom --no-owner --file="$HOME/vham-rerun/before-redeploy.dump" "$DATABASE_URL"
   ```

   Keep the dump outside the repository until the owner accepts the run. If the PostgreSQL client tools are not installed, run them from the `postgres:16-alpine` image, as `PG_TOOLS` does in `scripts/db/backup-restore-check.sh` ([BACKUP_RESTORE.md](../operations/BACKUP_RESTORE.md)). Record the file name and size.

5. Run `pnpm --filter @vham/api db:migrate` (TESTNET.md step 2). It marks the campaigns linked before migration 0011 as `pre-adr-0011`.
6. **(owner)** Deploy with the commands in [Deploy](TESTNET.md#deploy). Set `CLAIM_SIGNER_ADDRESS` to the address of the API's `CLAIM_SIGNER_PRIVATE_KEY`. The script asks for the `deployer` keystore password, broadcasts, and writes `packages/contracts/deployments/84532.json`. Record the deploy transaction, its block, and the contract address.
7. Read the new contract back:

   ```bash
   CM=<campaignManager from deployments/84532.json>
   cast call $CM "owner()(address)" --rpc-url "$EVM_RPC_URL"
   cast call $CM "authorizedSigner()(address)" --rpc-url "$EVM_RPC_URL"
   cast call $CM "rewardToken()(address)" --rpc-url "$EVM_RPC_URL"
   ```

   Each value must equal the deployment record, and `rewardToken` must be the Circle USDC address. Commit `deployments/84532.json` (TESTNET.md step 3).

8. Set the API environment from the record ([Configure the API](TESTNET.md#configure-the-api), TESTNET.md step 4). For this run, also check these values:
   - `INDEXER_MAX_BLOCK_RANGE=200` with the public RPC;
   - `SIWE_DOMAIN=localhost:3000`;
   - `WORLD_ID_MODE=live`, `WORLD_ID_ENVIRONMENT=production`, and the World ID values of [DEMO.md](../DEMO.md), including `PARTICIPANT_KEY_SECRET`. In live mode, the World ID request of step 15 answers `503 WORLD_ID_NOT_CONFIGURED` unless `WORLD_ID_APP_ID`, `WORLD_ID_RP_ID`, `RP_SIGNING_KEY`, and `PARTICIPANT_KEY_SECRET` are all set;
   - `ADVERTISER_ALLOWLIST` with the advertiser wallet, so that its drafts start approved. Otherwise an operator approves each draft ([MODERATION.md](../operations/MODERATION.md));
   - `WEB_ORIGIN`, which the #72 change adds, is optional. Leave it unset, or set it to `http://localhost:3000`. If you set it, its host must equal `SIWE_DOMAIN`, or the API refuses to start.

9. Start the API, the indexer worker, and the web app (TESTNET.md step 5), each in its own terminal with `.env` loaded:

   ```bash
   pnpm --filter @vham/api dev 2>&1 | tee "$HOME/vham-rerun/api.log"
   pnpm --filter @vham/api indexer
   API_URL=http://localhost:3001 NEXT_PUBLIC_CHAIN_ID=84532 pnpm --filter @vham/web dev
   ```

   The API and the worker start only if the chain, the USDC address, and the contract pass their startup checks. Then `curl -si http://localhost:3001/health/ready` shows status `200`, and `curl -s http://localhost:3001/v1/chain` returns chain `84532`, the new `campaignManager`, and the Circle `usdc`. Record the `/v1/chain` response.

## Create and fund two campaigns

Use the advertiser's browser profile. Create both campaigns before their start time.

10. **(owner)** Open http://localhost:3000/advertiser, connect the advertiser wallet, and press **Sign in with Ethereum**. If #72 is merged, check in devtools that the advertiser requests carry the session cookie and no `Authorization` header.
11. **(owner)** Create campaign 1. Enter a public `https` content URL, reward `1`, max completions `2`, a start at least 15 minutes ahead, and an end 2 hours after the start. Add one question with two choices, and mark the correct one. Press **Save draft**, then **Create on-chain**, then **Approve & fund**. If the page says that the creation is not confirmed yet, press **Check again**, which never sends a transaction. The status moves from `draft` to `pending_onchain` to `active`, and the page shows the participant link. Record the campaign id, the on-chain id, and the create, approve, and fund transactions with their blocks.
12. **(owner)** Open http://localhost:3000/advertiser in a second tab, sign in, and create campaign 2 the same way with max completions `1`. Record the same items.

    **Optional.** To show an expired campaign instead of a closed one, give campaign 2 a start 30 minutes after campaign 1's start, or later if you expect steps 14 to 25 to take longer. End it 15 minutes after its own start, which is the shortest window the contract accepts. The steps in [Optional: an expired campaign](#optional-an-expired-campaign) replace steps 27 and 28.

13. Open `http://localhost:3000/api/v1/campaigns/<campaign 1 id>/mission`. It lists the question and its choices, and it has no `answerKey` or `passThreshold` field. Record that both fields are absent.

## Run campaign 1

Use the participants' browser profile and wait until the start time. Open devtools on the **Network** tab before you press a button, so that you can read each request.

For the phone layout, switch the devtools device toolbar to a width of 375 px and save a screenshot of each participant state. Label these screenshots **emulation**. The toolbar changes the viewport size and the user agent, and the browser engine stays the desktop one. If IDKit shows a button instead of a QR code at that width, switch back to the desktop width before you press **Verify with World ID**. In that case, step 15 has no phone-width screenshot of the World ID widget.

**Optional: real phone.** To add two screenshots from a phone's own browser, put the phone on the laptop's network. Open the `Network:` address that the web app prints when it starts, followed by `/mission?campaign=<campaign 1 id>`. Participants need no sign-in, and the Next rewrite forwards `/api/*` to the API on the laptop. Take the first screenshot before step 14, when the page offers **Connect wallet**, and the second at step 25, when it says the campaign is `closed`. Label both **real phone**.

The phone cannot complete the states after **Connect wallet**, for two reasons:

- The page reaches a wallet only through `window.ethereum`, which only a wallet extension or a wallet app's in-app browser provides.
- A `http://` LAN address is not a secure context, so `crypto.randomUUID()` in the **Submit answers** handler (`apps/web/app/mission/page.tsx`) fails there.

Capture those states in the laptop browser and label them **emulation**. Do not press **Verify with World ID** on the phone. If the phone has a wallet other than wallet A, the verification binds your World ID to that wallet for campaign 1, and step 15 then fails the way step 17 does for wallet B.

The web app's terminal may print `Blocked cross-origin request to Next.js dev resource` for the phone. Next.js allows only `localhost` for its dev resources unless `allowedDevOrigins` lists the host. Do not change that config for this pass. If the page does not work on the phone, skip the pass.

14. **(owner)** Open campaign 1's participant link and connect wallet A.
15. **(owner)** Press **Verify with World ID** and scan the QR code with World App. The page moves to **3. Read and answer**, and `eligibility/verify` returns `201`. In that request's payload, read `idkitResponse.protocol_version`, which must be `4.0`. Also check that `idkitResponse.responses[0].signal_hash` is not `0x0`, which shows that the page sent the #71 signal. Record the status, the protocol version, and whether `signal_hash` was set. Copy nothing else from the payload.

    If the page's own request returns `403 SIGNAL_MISMATCH`, the result's `signal_hash` is missing or differs from the API's. That is a wrong signal shape, not a relayed proof. Stop and record it.

    If World App shows "Verification unavailable", scan again with the other scanner. On 2026-10-14 the second scan worked, and the API never received the first one.

16. **(owner)** Replay the same proof for wallet B. Run this step and step 16b right after the scan. The RP signature that opened the request lasts 300 seconds, and the verify reference does not say whether World still accepts an older result. In devtools, copy the `eligibility/verify` request as fetch and paste it in the console. Before the final `;`, append `.then((r) => r.json().then((body) => console.log(r.status, body.error?.code)))`. Then run the request twice:

    1. Unchanged. This is the control for step 16b. The console prints `200 undefined` when World accepts a replay of the proof. Record the status.
    2. With `claimant` in the body changed to wallet B's address. The API refuses it with `403 SIGNAL_MISMATCH` before it calls World, because the proof's `signal_hash` belongs to wallet A's signal. This tests the API's own check only. Record the status and the code. Any other code means that this check did not prove the wallet binding, so record that code too.

    **16b. (owner)** Test that World binds the signal into the proof. The API cannot show this, because it compares the hashes before it calls World. Replace the proof's `signal_hash` with the hash of wallet B's signal. The API's check then passes and the API forwards the proof to World, which must refuse it, because the scan covered wallet A's signal. Sub-steps 1 and 2 do not depend on the proof, so you can run them before the scan in step 15.

    1. Get wallet B's signal. In the console, run the following with campaign 1's id and wallet B's address. In live mode the response is `{ mode: "live", appId, action, environment, rpContext, signal }`. The snippet copies the `signal` to the clipboard and the console shows a `Promise` line. The signal is `0x` followed by 64 hex digits. If the API answers `503 WORLD_ID_NOT_CONFIGURED` instead, a World ID value from step 8 is missing, and the console prints that code.

       ```js
       fetch("/api/v1/campaigns/<campaign 1 id>/world-id/request", {
         method: "POST",
         headers: { "content-type": "application/json" },
         body: JSON.stringify({ claimant: "<wallet B>" }),
       })
         .then((r) => r.json())
         .then((j) => (j.signal ? copy(j.signal) : console.log(j.error?.code)));
       ```

    2. Hash the signal in the WSL terminal. IDKit sets `signal_hash` to the keccak-256 hash of the signal's bytes, shifted right by 8 bits and written as 32 bytes. The shift drops the last byte and puts a `00` byte in front, which `cut` and `printf` do below. `cast keccak` hashes a `0x` argument as bytes. The result is the value that `signalHash` in `apps/api/src/identity/world-id-signal.ts` computes.

       ```bash
       SIGNAL=<paste the signal>
       printf '0x00%s\n' "$(cast keccak "$SIGNAL" | cut -c3-64)"
       ```

       The output has 66 characters and starts with `0x00`. To test the command first, set `SIGNAL` to the made-up value `0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`. The output must be `0x008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd`, which is what `hashSignal` in `@worldcoin/idkit-core` 4.4.0 returns for that value.

    3. In the console, press the Up arrow until the request of step 16 appears with `claimant` set to wallet B. Replace the `signal_hash` of every entry in `idkitResponse.responses` with the output of sub-step 2, and run it. The body in the pasted text is one JSON string, so each entry reads `\"signal_hash\":\"<old hash>\"`. Replace the old hash, and keep the backslashes and quotes.

    Read the result of sub-step 3:

    - `403 VERIFICATION_FAILED` means World refused the changed proof. When the control returned `200`, this shows that World binds the signal. Record the status and the code.
    - `403 SIGNAL_MISMATCH` means an entry still has the old hash, or the new hash is wrong. The request did not reach World. Correct it and run it again.
    - `503 PROVIDER_UNAVAILABLE` means World gave no verdict. Run it again. If it persists, record the status and treat 16b as unproven.
    - `409 PARTICIPANT_WALLET_MISMATCH`, `200`, or `201` means World accepted the changed proof, so the signal binds nothing. The `409` appears because the API's own check for a second wallet then runs. Stop the run and record it.

    If the control did not return `200`, World may refuse every replay, and 16b cannot tell that from a refused signal. Record both statuses and leave the #71 row of the table open.

    Then clear the console and copy other text to the clipboard, because the console held the proof and the clipboard held the signal. The pasted requests stay in the console history until you clear it in step 32.

17. **(owner)** Verify the same person with wallet B. Switch the browser wallet to wallet B, open the participant link in a new tab, connect, press **Verify with World ID**, and scan again. The page refuses wallet B with "You already verified for this campaign with a different wallet." (`409 PARTICIPANT_WALLET_MISMATCH`). If World refuses a second proof for the same action, the page says "World ID verification failed." (`403 VERIFICATION_FAILED`) instead. Either way, wallet B gets no eligibility. Record the code and the `protocol_version`. Close the tab and switch back to wallet A.
18. **(owner)** In wallet A's tab, choose the wrong answer and press **Submit answers**. Each person has two attempts per campaign, so do this once only. The page says "Not quite. Re-read the content and try once more." The `submissions` response has `status: "rejected"`, `rejectionCode: "COMPREHENSION_FAILED"`, and `claim: null`. Record these fields.
19. **(owner)** Choose the correct answer and press **Submit answers**. The page moves to **4. Claim your reward**. The `submissions` response has `status: "accepted"` and `claim.status: "authorized"`, and `claim.authorization.expiresAt` is 900 seconds after `issuedAt`. Record the submission id, `issuedAt`, and `expiresAt`.

    Steps 20 to 23 must finish before `expiresAt`. After the close in step 21, the API cannot issue a new authorization. If `expiresAt` passes before the claim in step 22, create a new campaign and repeat steps 11 and 14 to 23.

20. **(owner)** Try a second completion with wallet A. Copy the `submissions` request as fetch, set its `Idempotency-Key` header to `crypto.randomUUID()`, append the `.then` from step 16, and run it. The API refuses it with `409 ALREADY_COMPLETED`. Record the code.
21. **(owner)** Close campaign 1 while wallet A's authorization is still unredeemed. In campaign 1's advertiser tab, press **Close campaign**. The page shows **Campaign closed** when the receipt arrives. The status `closed` follows about a minute later, once the indexer confirms the event ([Wait for the status after a transaction](#wait-for-the-status-after-a-transaction)). The page also shows when the refund opens, with a countdown. Record the close transaction, its block, and `closedAt`, the ninth field of the `campaigns(uint256)` call in step 30.
22. **(owner)** In wallet A's tab, press **Claim USDC** and confirm in the wallet. The page shows **Claim sent** with the hash, then **Reward paid to your wallet.** The contract pays an authorization issued before the close until it expires ([Issuance and Expiry](../architecture/CLAIM_AUTHORIZATION.md#issuance-and-expiry)). Record the claim transaction and its block. Then read its receipt, which needs no historical state:

    ```bash
    cast receipt <claim tx hash> logs --rpc-url "$EVM_RPC_URL"
    ```

    The output is one JSON array with two logs, in this order. Addresses print in lowercase, and addresses in `topics` are left-padded to 32 bytes.

    - The first log is the USDC `Transfer`. Its `address` is `$USDC`. Its `topics[0]` is `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`. Its `topics[1]` is `$CM` and its `topics[2]` is wallet A. Its `data` is `0x00000000000000000000000000000000000000000000000000000000000f4240`, which is `1000000`.
    - The second log is the contract's `RewardClaimed`. Its `address` is `$CM`. Its `topics[0]` is `0x26b1605560a38613ed768e913564f2d9a454c54f88abaeb323ce9a8a8f79ed65`. Its `topics[1]` is campaign 1's on-chain id and its `topics[2]` is wallet A. The first 32 bytes of its `data` are the same amount.

    Record the amount and the `logIndex` of both logs. The explorer's **Logs** tab shows the same two events decoded.

23. Replay the claim without sending it:

    ```bash
    INPUT=$(cast tx <claim tx hash> input --rpc-url "$EVM_RPC_URL")
    cast call $CM --data "$INPUT" --from <wallet A> --rpc-url "$EVM_RPC_URL"
    ```

    The call reverts with data `0x1fb09b80` (`NonceAlreadyUsed`). After `expiresAt`, it reverts with `AuthorizationExpired` first and no longer shows the duplicate check. Record the revert. This is a simulation with `eth_call`. It sends no transaction, so the chain holds no rejected claim.

24. **(owner)** After `expiresAt`, reload wallet A's tab, connect wallet A, and press **Claim USDC**. The page says "This reward was already paid to your wallet." (`409 ALREADY_CLAIMED`) and shows the paid state. Record the code. The API answers before the page sends a transaction, so this step does not reach the contract.
25. Open campaign 1's participant link in a new tab and do not connect. The page says that the campaign is `closed` and that rewards can only be earned while it is active. Record a screenshot.

## Show that a closed campaign refuses a completion

Run campaign 2 while you wait for campaign 1's refund.

26. **(owner)** In a new tab, open campaign 2's participant link, connect wallet A, press **Verify with World ID**, and scan. Choose the correct answer. Do not press **Submit answers** yet, and do not reload this tab. Record the `protocol_version`.
27. **(owner)** In campaign 2's advertiser tab, press **Close campaign**. Wait until the page shows the status `closed`, which takes about a minute after the receipt because the indexer must confirm the event. Record the transaction and its block.
28. **(owner)** In the participant tab, press **Submit answers**. The page says "This campaign is not active right now." (`409 CAMPAIGN_NOT_ACTIVE`). The API read the contract, recorded nothing, and issued no authorization. Record the code.

### Optional: an expired campaign

Steps 26 to 28 show a campaign that its advertiser closed. This variant shows a campaign that ends without a close. It needs campaign 2 created with the short window of step 12, which is open for only 15 minutes. Run step 26 inside that window, skip step 27, and replace step 28 with these steps:

1. Wait until campaign 2's end time has passed. Do not close the campaign.
2. **(owner)** In the participant tab, press **Submit answers**. The page says "Your verification expired with the campaign." (`403 ELIGIBILITY_EXPIRED`). The API ends a person's eligibility at the campaign's end time. It checks that before it reads the contract, so `CAMPAIGN_NOT_ACTIVE` does not appear here. The API issued no authorization. Record the code.
3. In step 29, count campaign 2's refund from its `endTime`, because nobody closed the campaign and its `closedAt` is `0`. The refund opens at `endTime` + 901 seconds. The `endTime` is the eighth field of the `campaigns(uint256)` call in step 30.

## Refund, reconcile, and compare

29. **(owner)** Refund each campaign once its refund opens, 901 seconds after its `closedAt`. The contract refuses a refund while `block.timestamp` is at most `closedAt` + 900. Until then, this call reverts with `RefundNotAvailable` (`0x0b4d6981`) and sends nothing:

    ```bash
    cast call $CM "refundUnusedBudget(uint256)" <on-chain id> --from <advertiser> --rpc-url "$EVM_RPC_URL"
    ```

    When the advertiser page shows **Refund unused budget**, press it. The status becomes `settled` about a minute after the receipt, once the indexer confirms the event. Record each refund transaction, its block, and its `CampaignRefunded` amount, which is `1000000` for each campaign.

30. Compare the analytics with the chain. Wait until both campaigns show the status `settled`. In each advertiser tab, press **Refresh** and copy the response of the `analytics` request from devtools. Then read each campaign and the contract's balance:

    ```bash
    cast call $CM "campaigns(uint256)(address,uint128,uint128,uint96,uint32,uint32,uint64,uint64,uint64,uint8)" <on-chain id> --rpc-url "$EVM_RPC_URL"
    cast call $USDC "balanceOf(address)(uint256)" $CM --rpc-url "$EVM_RPC_URL"
    ```

    | Analytics field                            | Campaign 1              | Campaign 2       | Same value on-chain           |
    | ------------------------------------------ | ----------------------- | ---------------- | ----------------------------- |
    | `status`                                   | `settled`               | `settled`        | status `4`                    |
    | `onchainContractAddress`                   | the new contract        | the new contract | `$CM`                         |
    | `submissions.accepted`                     | `1`                     | `0`              |                               |
    | `submissions.rejected`                     | `1`                     | `0`              |                               |
    | `submissions.flaggedAccepted`              | `1` (`PASSED_ON_RETRY`) | `0`              |                               |
    | `settlement.confirmed.funded`              | `2000000`               | `1000000`        | `fundedBudget`                |
    | `settlement.confirmed.paidRewards`         | `1000000`               | `0`              | `paidRewards`                 |
    | `settlement.confirmed.paidCompletions`     | `1`                     | `0`              | `paidCompletions`             |
    | `settlement.confirmed.refunded`            | `1000000`               | `1000000`        | the `CampaignRefunded` amount |
    | `settlement.confirmed.remaining`           | `0`                     | `0`              |                               |
    | `settlement.confirmed.accountingViolation` | `false`                 | `false`          |                               |
    | `settlement.hasUnconfirmedEvents`          | `false`                 | `false`          |                               |

    The contract's USDC balance is `0`. `PASSED_ON_RETRY` flags campaign 1's completion because it followed the rejected attempt of step 18. Record the analytics fields and the on-chain values.

31. Run `pnpm --filter @vham/api reconcile`. It prints `"findings": []` and `"campaignsChecked": 2`, and exits with code `0`. Record the JSON and the exit code. [VhamReconciliationFinding](../operations/RUNBOOK.md#vhamreconciliationfinding) explains each kind of finding.
32. Check what the browser and the logs saw:
    - In the web app's terminal, `env | grep '^NEXT_PUBLIC_'` lists only `NEXT_PUBLIC_CHAIN_ID` and, if set, `NEXT_PUBLIC_WORLD_ID_MODE`. Next.js puts only `NEXT_PUBLIC_` variables in the browser bundle.
    - `grep -E '"(nullifier|proof|signal|signal_hash|idkitResponse)"' "$HOME/vham-rerun/api.log" | grep -v '\[redacted\]'` prints nothing.
    - The console of each participant tab shows no proof, nullifier, or signal, except for the requests you pasted in steps 16 and 16b.
    - If #72 is merged, the console shows no Content-Security-Policy violation during sign-in, the wallet prompts, the World ID widget, or the claim.

    Record each result. Then clear the DevTools history, because Chrome keeps console input across sessions and the requests of steps 16 and 16b hold the proof. Open DevTools **Settings**, choose **Preferences**, and press **Restore defaults and reload**. That also resets your other DevTools settings.

33. Record the URL of the passing `e2e` CI job for the deployed commit. That job runs [`apps/api/e2e/poc.e2e.ts`](../../apps/api/e2e/poc.e2e.ts) on anvil. It loses the `createCampaign` response after broadcast, sends the same draft again from a second client, and creates a same-parameter campaign for another draft. Exactly one campaign is linked to the draft.

After the run, commit the evidence section in DEMO.md and update `docs/SDLC_STATUS.md`. The owner closes #12 and #13 once every row below has its evidence.

## Acceptance criteria and the steps that prove them

| Issue        | Criterion (verbatim)                                                                           | Steps                                                       |
| ------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| #13          | current official Base test environment and test-USDC asset/address are verified and documented | 1, 7, 9                                                     |
| #13          | advertiser can create/fund the campaign                                                        | 11, 12                                                      |
| #13          | valid unique human completion is accepted                                                      | 15, 19                                                      |
| #13          | invalid/duplicate human completion is rejected                                                 | 16, 16b, 17, 18, 20                                         |
| #13          | valid claimant receives exact expected reward                                                  | 22                                                          |
| #13          | duplicate on-chain claim is rejected                                                           | 23 (`eth_call`), 24 (API); the chain rejects no transaction |
| #13          | expired/closed campaign rejects new completion liability                                       | 26, 27, 28; optional variant for expiry                     |
| #13          | a valid pre-close authorization follows documented close/refund semantics                      | 19, 21, 22, 29                                              |
| #13          | unused budget refunds correctly                                                                | 29, 30                                                      |
| #13          | indexer/reconciliation reaches the same financial state as the chain                           | 30, 31                                                      |
| #13          | at least one simulated RPC timeout/retry is reconciled without duplicate economic action       | 33 (CI `e2e` job on anvil)                                  |
| #13          | advertiser analytics match chain + submission evidence                                         | 30                                                          |
| #13          | E2E evidence/runbook is documented                                                             | this runbook and the DEMO.md evidence section               |
| #12          | mobile mission page                                                                            | 14 to 28 (emulation); optional real phone                   |
| #12          | World ID eligibility UX                                                                        | 15, 17, 26                                                  |
| #12          | sponsored content + comprehension questions render from server mission definition              | 13, 18                                                      |
| #12          | comprehension submission                                                                       | 18, 19                                                      |
| #12          | accepted/rejected/pending states                                                               | 18, 19, 22                                                  |
| #12          | EIP-712 authorization is returned only after valid eligibility + engagement completion         | 17, 18, 19, 28                                              |
| #12          | claim transaction UX                                                                           | 22                                                          |
| #12          | duplicate completion/claim errors handled clearly                                              | 17, 20, 24                                                  |
| #12          | expired/closed campaign state handled                                                          | 25, 28                                                      |
| #12          | no answer key or sensitive proof material is exposed in client bundles/logs                    | 13, 32                                                      |
| #71          | a real World App proof is bound to its wallet and refused for another wallet                   | 15, 16, 16b                                                 |
| 4.0-only fix | the page's request returns a World ID 4.0 proof                                                | 15, 17, 26                                                  |
| #69          | the advertiser closes and refunds from the page                                                | 21, 27, 29                                                  |

## Abort the run if

Stop, record what you saw, and fix the cause before you continue, if any of these happens:

- The fact re-check in step 1 finds a changed value.
- The old contract is not settled. A campaign on it has a status other than `4` or `5`, it holds test USDC, or the TESTNET.md query returns rows (step 2).
- The API or the indexer worker refuses to start (step 9), for example with "is a CampaignManager from before ADR-0011", "does not match the official USDC", or "has no contract code". Fix the configuration. Never bypass the check.
- A transaction reverts. Only the `cast call` simulations of steps 23 and 29 are meant to revert.
- World ID returns `protocol_version` `3.0`, the API answers `INVALID_PROOF_PAYLOAD` to the page's own request, or World App cannot complete the 4.0 request. Do not turn legacy proofs back on.
- The API answers `403 SIGNAL_MISMATCH` to the page's own request in step 15. The signal has the wrong shape. It is not a relayed proof.
- Step 16b returns `409 PARTICIPANT_WALLET_MISMATCH`, `200`, or `201`. World accepted a proof with a changed `signal_hash`, so the signal binds nothing. Revisit the #71 update in [ADR-0007](../adr/0007-world-id-integration.md) before you continue.
- World ID verification fails for a new campaign's action. Check whether World now requires v4 actions to be registered in the Developer Portal before you change anything (step 1).
- The reconciliation reports a finding, or the analytics differ from the chain (steps 30 and 31).
- The API returns `CHAIN_HALTED`. Follow [VhamReorgBeyondConfirmations](../operations/RUNBOOK.md#vhamreorgbeyondconfirmations).
