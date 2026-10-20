# How to redeploy CampaignManager and re-run the POC on Base Sepolia

> Issues #12 and #13, ADR-0011. The external facts and the retired contract were last checked on **2026-10-20**. Repeat both checks on the day of the run (steps 1 and 2).

This runbook deploys the ADR-0011 `CampaignManager` to Base Sepolia, moves the API and its database to it, and runs the POC end to end in the web app. Campaign 1 runs the main flow. Campaign 2 shows that a closed campaign refuses a completion. Each step says what you should see and what to record. The [table at the end](#acceptance-criteria-and-the-steps-that-prove-them) maps every acceptance criterion of #12 and #13 to the step that proves it.

Plan for about 90 minutes. Each refund opens 15 minutes after its campaign closes.

## Who does what

The owner does every step that needs a key, a password, or the phone. Nobody else can do these steps:

- the deploy, which signs with the Foundry keystore `deployer` and asks for its password;
- every wallet signature: the advertiser's sign-in, create, approve, fund, close, and refund, and participant wallet A's claim;
- every World App scan.

The operator runs the services, the database commands, and the read-only checks, with the `.env` that the owner provides. The operator needs no wallet key. One person can do both roles. Steps for the owner say **(owner)**.

Run `forge` and `cast` in WSL, where Foundry is installed. The commands use bash syntax. [DEMO.md](../DEMO.md) shows how to load `.env` in bash and in PowerShell. The `cast` commands reuse `USDC` from step 2, `CM` from step 7, and `EVM_RPC_URL`, so run them in one WSL terminal.

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

### Record evidence as you go

Record the evidence in a new section of [DEMO.md](../DEMO.md), in the table format of the 2026-10-14 run:

- the hash and block of every transaction;
- the HTTP status and error code of every refusal;
- the analytics fields of step 30 and the reconciliation report of step 31;
- the World ID `protocol_version` of every scan.

To read a transaction's block, use the explorer or `cast receipt <hash> blockNumber --rpc-url "$EVM_RPC_URL"`.

Never record the World ID proof, nullifier, signal, or `signal_hash`, the eligibility token, the `rp_context`, a value from `.env`, or an RPC URL that carries an API key.

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

2. Confirm that the old contract owes nothing. [TESTNET.md](TESTNET.md#moving-to-a-new-campaignmanager) allows the switch only when every campaign on the old contract is settled or cancelled. Read the contract:

   ```bash
   OLD=0x12cc9447CEb3f8E75dDf4463A1A4D9feB42bDFEc
   USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e
   RPC=https://sepolia.base.org
   cast call $OLD "campaignCount()(uint256)" --rpc-url $RPC
   cast call $OLD "campaigns(uint256)(address,uint128,uint128,uint96,uint32,uint32,uint64,uint64,uint64,uint8)" 1 --rpc-url $RPC
   cast call $USDC "balanceOf(address)(uint256)" $OLD --rpc-url $RPC
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
   - `WORLD_ID_MODE=live`, `WORLD_ID_ENVIRONMENT=production`, and the World ID values of [DEMO.md](../DEMO.md), including `PARTICIPANT_KEY_SECRET`;
   - `ADVERTISER_ALLOWLIST` with the advertiser wallet, so that its drafts start approved. Otherwise an operator approves each draft ([MODERATION.md](../operations/MODERATION.md)).

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
13. Open `http://localhost:3000/api/v1/campaigns/<campaign 1 id>/mission`. It lists the question and its choices, and it has no `answerKey` or `passThreshold` field. Record that both fields are absent.

## Run campaign 1

Use the participants' browser profile and wait until the start time. Open devtools on the **Network** tab before you press a button, so that you can read each request.

For the phone layout, switch the devtools device toolbar to a width of 375 px and save a screenshot of each participant state. If IDKit shows a button instead of a QR code at that width, switch back to the desktop width before you press **Verify with World ID**.

14. **(owner)** Open campaign 1's participant link and connect wallet A.
15. **(owner)** Press **Verify with World ID** and scan the QR code with World App. The page moves to **3. Read and answer**, and `eligibility/verify` returns `201`. In that request's payload, read `idkitResponse.protocol_version`, which must be `4.0`. Also check that `idkitResponse.responses[0].signal_hash` is not `0x0`, which shows that the page sent the #71 signal. Record the status, the protocol version, and whether `signal_hash` was set. Copy nothing else from the payload.

    If World App shows "Verification unavailable", scan again with the other scanner. On 2026-10-14 the second scan worked, and the API never received the first one.

16. **(owner)** Replay the same proof for wallet B. In devtools, copy the `eligibility/verify` request as fetch and paste it in the console. Change `claimant` in the body to wallet B's address, append `.then((r) => r.json()).then(console.log)`, and run it. The API refuses it with `SIGNAL_MISMATCH`. Record the status and the code. Any other code means that this check did not prove the wallet binding, so record that code too. Then clear the console and copy other text to the clipboard, because both held the proof.
17. **(owner)** Verify the same person with wallet B. Switch the browser wallet to wallet B, open the participant link in a new tab, connect, press **Verify with World ID**, and scan again. The page refuses wallet B with "You already verified for this campaign with a different wallet." (`409 PARTICIPANT_WALLET_MISMATCH`). If World refuses a second proof for the same action, the page says "World ID verification failed." (`403 VERIFICATION_FAILED`) instead. Either way, wallet B gets no eligibility. Record the code and the `protocol_version`. Close the tab and switch back to wallet A.
18. **(owner)** In wallet A's tab, choose the wrong answer and press **Submit answers**. Each person has two attempts per campaign, so do this once only. The page says "Not quite. Re-read the content and try once more." The `submissions` response has `status: "rejected"`, `rejectionCode: "COMPREHENSION_FAILED"`, and `claim: null`. Record these fields.
19. **(owner)** Choose the correct answer and press **Submit answers**. The page moves to **4. Claim your reward**. The `submissions` response has `status: "accepted"` and `claim.status: "authorized"`, and `claim.authorization.expiresAt` is 900 seconds after `issuedAt`. Record the submission id, `issuedAt`, and `expiresAt`.

    Steps 20 to 23 must finish before `expiresAt`. After the close in step 21, the API cannot issue a new authorization. If `expiresAt` passes before the claim in step 22, create a new campaign and repeat steps 11 and 14 to 23.

20. **(owner)** Try a second completion with wallet A. Copy the `submissions` request as fetch, set its `Idempotency-Key` header to `crypto.randomUUID()`, append the `.then` from step 16, and run it. The API refuses it with `409 ALREADY_COMPLETED`. Record the code.
21. **(owner)** Close campaign 1 while wallet A's authorization is still unredeemed. In campaign 1's advertiser tab, press **Close campaign**. Once the transaction is confirmed, the status is `closed` and the page shows when the refund opens, with a countdown. Record the close transaction, its block, and `closedAt`, the ninth field of the `campaigns(uint256)` call in step 30.
22. **(owner)** In wallet A's tab, press **Claim USDC** and confirm in the wallet. The page shows **Claim sent** with the hash, then **Reward paid to your wallet.** The contract pays an authorization issued before the close until it expires ([Issuance and Expiry](../architecture/CLAIM_AUTHORIZATION.md#issuance-and-expiry)). Record the claim transaction and its block. Then read wallet A's balance on both sides of the claim:

    ```bash
    cast call $USDC "balanceOf(address)(uint256)" <wallet A> --block <claim block - 1> --rpc-url "$EVM_RPC_URL"
    cast call $USDC "balanceOf(address)(uint256)" <wallet A> --block <claim block> --rpc-url "$EVM_RPC_URL"
    ```

    The difference must be exactly `1000000`. Record both values.

23. Replay the claim without sending it:

    ```bash
    INPUT=$(cast tx <claim tx hash> input --rpc-url "$EVM_RPC_URL")
    cast call $CM --data "$INPUT" --from <wallet A> --rpc-url "$EVM_RPC_URL"
    ```

    The call reverts with data `0x1fb09b80` (`NonceAlreadyUsed`). After `expiresAt`, it reverts with `AuthorizationExpired` first and no longer shows the duplicate check. Record the revert.

24. **(owner)** After `expiresAt`, reload wallet A's tab, connect wallet A, and press **Claim USDC**. The page says "This reward was already paid to your wallet." (`409 ALREADY_CLAIMED`) and shows the paid state. Record the code.
25. Open campaign 1's participant link in a new tab and do not connect. The page says that the campaign is `closed` and that rewards can only be earned while it is active. Record a screenshot.

## Show that a closed campaign refuses a completion

Run campaign 2 while you wait for campaign 1's refund.

26. **(owner)** In a new tab, open campaign 2's participant link, connect wallet A, press **Verify with World ID**, and scan. Choose the correct answer. Do not press **Submit answers** yet, and do not reload this tab. Record the `protocol_version`.
27. **(owner)** In campaign 2's advertiser tab, press **Close campaign** and wait until the status is `closed`. Record the transaction and its block.
28. **(owner)** In the participant tab, press **Submit answers**. The page says "This campaign is not active right now." (`409 CAMPAIGN_NOT_ACTIVE`). The API read the contract, recorded nothing, and issued no authorization. Record the code.

## Refund, reconcile, and compare

29. **(owner)** Refund each campaign once its refund opens, 15 minutes after its `closedAt`. Until then, this call reverts with `RefundNotAvailable` (`0x0b4d6981`) and sends nothing:

    ```bash
    cast call $CM "refundUnusedBudget(uint256)" <on-chain id> --from <advertiser> --rpc-url "$EVM_RPC_URL"
    ```

    When the advertiser page shows **Refund unused budget**, press it. The status becomes `settled`. Record each refund transaction, its block, and its `CampaignRefunded` amount, which is `1000000` for each campaign.

30. Compare the analytics with the chain. In each advertiser tab, press **Refresh** and copy the response of the `analytics` request from devtools. Then read each campaign and the contract's balance:

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
    - The console of each participant tab shows no proof, nullifier, or signal.
    - If #72 is merged, the console shows no Content-Security-Policy violation during sign-in, the wallet prompts, the World ID widget, or the claim.

    Record each result.

33. Record the URL of the passing `e2e` CI job for the deployed commit. That job runs [`apps/api/e2e/poc.e2e.ts`](../../apps/api/e2e/poc.e2e.ts) on anvil. It loses the `createCampaign` response after broadcast, sends the same draft again from a second client, and creates a same-parameter campaign for another draft. Exactly one campaign is linked to the draft.

After the run, commit the evidence section in DEMO.md and update `docs/SDLC_STATUS.md`. The owner closes #12 and #13 once every row below has its evidence.

## Acceptance criteria and the steps that prove them

| Issue        | Criterion (verbatim)                                                                           | Steps                                         |
| ------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------- |
| #13          | current official Base test environment and test-USDC asset/address are verified and documented | 1, 7, 9                                       |
| #13          | advertiser can create/fund the campaign                                                        | 11, 12                                        |
| #13          | valid unique human completion is accepted                                                      | 15, 19                                        |
| #13          | invalid/duplicate human completion is rejected                                                 | 16, 17, 18, 20                                |
| #13          | valid claimant receives exact expected reward                                                  | 22                                            |
| #13          | duplicate on-chain claim is rejected                                                           | 23, 24                                        |
| #13          | expired/closed campaign rejects new completion liability                                       | 26, 27, 28                                    |
| #13          | a valid pre-close authorization follows documented close/refund semantics                      | 19, 21, 22, 29                                |
| #13          | unused budget refunds correctly                                                                | 29, 30                                        |
| #13          | indexer/reconciliation reaches the same financial state as the chain                           | 30, 31                                        |
| #13          | at least one simulated RPC timeout/retry is reconciled without duplicate economic action       | 33 (CI `e2e` job on anvil)                    |
| #13          | advertiser analytics match chain + submission evidence                                         | 30                                            |
| #13          | E2E evidence/runbook is documented                                                             | this runbook and the DEMO.md evidence section |
| #12          | mobile mission page                                                                            | 14 to 28 (375 px screenshots)                 |
| #12          | World ID eligibility UX                                                                        | 15, 17, 26                                    |
| #12          | sponsored content + comprehension questions render from server mission definition              | 13, 18                                        |
| #12          | comprehension submission                                                                       | 18, 19                                        |
| #12          | accepted/rejected/pending states                                                               | 18, 19, 22                                    |
| #12          | EIP-712 authorization is returned only after valid eligibility + engagement completion         | 17, 18, 19, 28                                |
| #12          | claim transaction UX                                                                           | 22                                            |
| #12          | duplicate completion/claim errors handled clearly                                              | 17, 20, 24                                    |
| #12          | expired/closed campaign state handled                                                          | 25, 28                                        |
| #12          | no answer key or sensitive proof material is exposed in client bundles/logs                    | 13, 32                                        |
| #71          | a real World App proof is bound to its wallet and refused for another wallet                   | 15, 16                                        |
| 4.0-only fix | the page's request returns a World ID 4.0 proof                                                | 15, 17, 26                                    |
| #69          | the advertiser closes and refunds from the page                                                | 21, 27, 29                                    |

## Abort the run if

Stop, record what you saw, and fix the cause before you continue, if any of these happens:

- The fact re-check in step 1 finds a changed value.
- The old contract is not settled. A campaign on it has a status other than `4` or `5`, it holds test USDC, or the TESTNET.md query returns rows (step 2).
- The API or the indexer worker refuses to start (step 9), for example with "is a CampaignManager from before ADR-0011", "does not match the official USDC", or "has no contract code". Fix the configuration. Never bypass the check.
- A transaction reverts. Only the `cast call` simulations of steps 23 and 29 are meant to revert.
- World ID returns `protocol_version` `3.0`, the API answers `INVALID_PROOF_PAYLOAD` to the page's own request, or World App cannot complete the 4.0 request. Do not turn legacy proofs back on.
- World ID verification fails for a new campaign's action. Check whether World now requires v4 actions to be registered in the Developer Portal before you change anything (step 1).
- The reconciliation reports a finding, or the analytics differ from the chain (steps 30 and 31).
- The API returns `CHAIN_HALTED`. Follow [VhamReorgBeyondConfirmations](../operations/RUNBOOK.md#vhamreorgbeyondconfirmations).
