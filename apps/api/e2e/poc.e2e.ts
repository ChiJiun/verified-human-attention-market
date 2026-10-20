/**
 * Local end-to-end POC (issue #13) against a real chain (anvil), the real
 * compiled CampaignManager, PostgreSQL and the real API.
 *
 * Only World ID is simulated (it needs a real World App). Everything that
 * moves or accounts for money is real: contract, EIP-712 signer, indexer,
 * reconciliation and analytics.
 *
 * Requires: `forge build` in packages/contracts, anvil on E2E_RPC_URL and
 * TEST_DATABASE_URL. Run with `pnpm --filter @vham/api test:e2e`.
 */
import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  keccak256,
  stringToBytes,
  type Hash,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { PostgresAuthRepository } from "../src/auth/repository.js";
import {
  autoLinkCreatedCampaigns,
  draftRefFor,
  readOnchainCampaign,
  syncCampaignStatuses,
} from "../src/campaigns/onchain.js";
import { PostgresCampaignRepository } from "../src/campaigns/repository.js";
import { PostgresChainEventRepository } from "../src/chain/events-repository.postgres.js";
import { indexOnce } from "../src/chain/indexer.js";
import { JsonRpcClient } from "../src/chain/rpc.js";
import { PostgresClaimRepository } from "../src/claims/repository.js";
import {
  checkReconciliation,
  type ReconciliationReport,
} from "../src/reconciliation/check.js";
import { createClaimSigner } from "../src/claims/signer.js";
import { createDatabase } from "../src/db/client.js";
import { PostgresEligibilityRepository } from "../src/eligibility/repository.js";
import { PostgresModerationRepository } from "../src/moderation/repository.js";
import { LocalSimulatedWorldIdVerifier } from "../src/identity/world-id.js";
import { PostgresSubmissionRepository } from "../src/submissions/repository.js";

const RPC_URL = process.env.E2E_RPC_URL ?? "http://127.0.0.1:8545";
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const DOMAIN = "e2e.vham.test";
const USDC = 1_000_000n;
const CONFIRMATIONS = 2;

const anvil = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

// Anvil's publicly documented development mnemonic (not a secret).
const MNEMONIC = "test test test test test test test test test test test junk";
const deployer = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const claimSignerAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const advertiser = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
const alice = mnemonicToAccount(MNEMONIC, { addressIndex: 3 });
const bob = mnemonicToAccount(MNEMONIC, { addressIndex: 4 });
const operator = mnemonicToAccount(MNEMONIC, { addressIndex: 5 });
const carol = mnemonicToAccount(MNEMONIC, { addressIndex: 7 });

function artifact(path: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(
    readFileSync(
      new URL(`../../../packages/contracts/out/${path}`, import.meta.url),
      "utf8",
    ),
  ) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

const describeE2e = DATABASE_URL ? describe : describe.skip;

describeE2e("POC economic loop on a local chain", () => {
  const database = createDatabase(DATABASE_URL ?? "postgres://unused");
  const transport = http(RPC_URL);
  const publicClient = createPublicClient({ chain: anvil, transport });
  const testClient = createTestClient({
    chain: anvil,
    mode: "anvil",
    transport,
  });
  const wallet = (account: typeof deployer) =>
    createWalletClient({ account, chain: anvil, transport });

  const manager = artifact("CampaignManager.sol/CampaignManager.json");
  const mockUsdc = artifact("CampaignManager.t.sol/MockUSDC.json");

  let clock = new Date();
  let managerAddress: Address;
  let usdcAddress: Address;
  let app: ReturnType<typeof buildApp>;
  let reconcile: () => Promise<void>;
  let checkSettlement: () => Promise<ReconciliationReport>;

  /** Moves chain time and the API clock together. */
  async function travelTo(date: Date) {
    // Mined transactions advance chain time; never move it backwards.
    const latest = await publicClient.getBlock();
    const target = BigInt(
      Math.max(Math.floor(date.getTime() / 1000), Number(latest.timestamp) + 1),
    );
    await testClient.setNextBlockTimestamp({ timestamp: target });
    await testClient.mine({ blocks: 1 });
    clock = new Date(Number(target) * 1000);
  }

  const seconds = (offset: number) => new Date(clock.getTime() + offset * 1000);

  async function send(
    account: typeof deployer,
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[],
  ) {
    const hash = await wallet(account).writeContract({
      address,
      abi,
      functionName,
      args,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    return hash;
  }

  /**
   * World ID needs the World App, so the local stand-in is used: the proof
   * is { action, simulatedHuman, signal } with the wallet-bound signal the
   * page would fetch for `claimant` (#71).
   */
  async function simulatedProof(
    campaignId: string,
    claimant: Address,
    human: string,
  ) {
    const requested = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/world-id/request`,
      payload: { claimant },
    });
    expect(requested.statusCode).toBe(200);
    const { action, signal } = requested.json<{
      action: string;
      signal: Hex;
    }>();
    return { action, simulatedHuman: human, signal };
  }

  async function signIn(account: typeof deployer) {
    const nonce = (
      await app.inject({ method: "POST", url: "/v1/auth/nonce" })
    ).json<{ nonce: string }>().nonce;
    const message = createSiweMessage({
      address: account.address,
      chainId: anvil.id,
      domain: DOMAIN,
      uri: `https://${DOMAIN}`,
      version: "1",
      nonce,
      issuedAt: clock,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { message, signature: await account.signMessage({ message }) },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ token: string }>().token;
  }

  beforeAll(async () => {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    // TRUNCATE: row triggers protect submissions and the audit log (#24).
    await database.db.execute(
      sql`TRUNCATE answers, submissions, eligibility, moderation_actions, campaign_reports, campaign_moderation, missions, campaigns, chain_events, reconciliation_state, auth_sessions, auth_nonces`,
    );

    // Start from "now" on both clocks.
    await travelTo(new Date(Math.floor(Date.now() / 1000) * 1000 + 10_000));

    const usdcHash = await wallet(deployer).deployContract({
      abi: mockUsdc.abi,
      bytecode: mockUsdc.bytecode,
    });
    usdcAddress = (
      await publicClient.waitForTransactionReceipt({ hash: usdcHash })
    ).contractAddress!;

    const managerHash = await wallet(deployer).deployContract({
      abi: manager.abi,
      bytecode: manager.bytecode,
      args: [usdcAddress, claimSignerAccount.address, USDC, 10, 10n * USDC],
    });
    const deployReceipt = await publicClient.waitForTransactionReceipt({
      hash: managerHash,
    });
    managerAddress = deployReceipt.contractAddress!;

    await send(deployer, usdcAddress, mockUsdc.abi, "mint", [
      advertiser.address,
      100n * USDC,
    ]);

    const campaignRepository = new PostgresCampaignRepository(database.db);
    const eventRepository = new PostgresChainEventRepository(database.db);
    const rpc = new JsonRpcClient(RPC_URL);
    const scope = {
      chainId: anvil.id,
      contractAddress: managerAddress.toLowerCase(),
    };
    const chain = { ...scope, usdcAddress: usdcAddress.toLowerCase() };
    const now = () => clock;

    app = buildApp({
      campaignRepository,
      eligibilityRepository: new PostgresEligibilityRepository(database.db),
      submissionRepository: new PostgresSubmissionRepository(database.db),
      claimRepository: new PostgresClaimRepository(database.db),
      claimSigner: createClaimSigner(
        toHex(claimSignerAccount.getHdKey().privateKey!),
      ),
      authRepository: new PostgresAuthRepository(database.db),
      siwe: { domain: DOMAIN, chainId: anvil.id },
      worldIdVerifier: new LocalSimulatedWorldIdVerifier(anvil.id),
      participantKeySecret: "e2e-participant-key-secret-0123456789",
      chainId: anvil.id,
      chain: {
        rpc,
        chain,
        events: eventRepository,
        now,
        confirmations: CONFIRMATIONS,
      },
      dailyPayoutLimitAtomic: 10n * USDC,
      // Production moderation: an operator must approve the campaign.
      moderationRepository: new PostgresModerationRepository(database.db),
      moderation: {
        mode: "review",
        operators: [operator.address.toLowerCase()],
        advertiserAllowlist: [],
      },
      now,
    });

    // Contract ↔ indexed events ↔ issued authorizations (#29).
    checkSettlement = () =>
      checkReconciliation({
        campaigns: campaignRepository,
        events: eventRepository,
        claims: new PostgresClaimRepository(database.db),
        rpc,
        chain: scope,
      });

    // What the indexer worker does on every pass.
    reconcile = async () => {
      await testClient.mine({ blocks: CONFIRMATIONS + 1 });
      await indexOnce(rpc, eventRepository, {
        chainId: anvil.id,
        contractAddress: scope.contractAddress,
        deployBlock: deployReceipt.blockNumber,
        confirmations: CONFIRMATIONS,
        maxBlockRange: 1_000n,
      });
      await autoLinkCreatedCampaigns({
        campaigns: campaignRepository,
        events: eventRepository,
        rpc,
        chain,
        now,
      });
      await syncCampaignStatuses({
        campaigns: campaignRepository,
        events: eventRepository,
        chain: scope,
        now,
      });
    };
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await database.close();
  });

  it("runs create → fund → verify → claim → close → refund with matching accounting", async () => {
    const advertiserToken = await signIn(advertiser);
    const auth = { authorization: `Bearer ${advertiserToken}` };
    const startAt = seconds(120);
    const endAt = seconds(3_600);

    // 1. Advertiser draft (SIWE-authenticated).
    const campaignBody = {
      advertiser: advertiser.address,
      contentUrl: "https://example.com/e2e-article",
      rewardPerCompletion: USDC.toString(),
      maxCompletions: 10,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      mission: {
        questions: [
          {
            id: "q1",
            prompt: "What does the article promote?",
            choices: [
              { id: "a", label: "Verified attention" },
              { id: "b", label: "Raw clicks" },
            ],
          },
        ],
        answerKey: { q1: "a" },
      },
    };
    const draft = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { ...auth, "idempotency-key": "e2e-campaign" },
      payload: campaignBody,
    });
    expect(draft.statusCode).toBe(201);
    const campaignId = draft.json<{ id: string }>().id;

    // 1b. Moderation: unreviewed campaigns cannot be published or served.
    const unreviewed = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/publish`,
      headers: auth,
    });
    expect(unreviewed.json()).toMatchObject({
      error: { code: "CAMPAIGN_NOT_APPROVED" },
    });
    const approval = await app.inject({
      method: "POST",
      url: `/v1/admin/campaigns/${campaignId}/moderation`,
      headers: { authorization: `Bearer ${await signIn(operator)}` },
      payload: { action: "approve", reason: "landing page reviewed" },
    });
    expect(approval.json()).toMatchObject({ status: "approved" });

    // 2. On-chain create from the publish intent, then verified linking.
    const intent = (
      await app.inject({
        method: "POST",
        url: `/v1/campaigns/${campaignId}/publish`,
        headers: auth,
      })
    ).json<{
      steps: { args: Record<string, string | number> }[];
    }>();
    const create = intent.steps[0]!.args;

    // RPC timeout after broadcast (#13), made safe by the draft reference
    // (ADR-0011). The node accepts createCampaign but the response is lost,
    // so the client never learns the hash. A second tab then sends the same
    // draft again, and the same wallet creates an identical campaign for a
    // different draft. Exactly one campaign may be linked to this draft.
    const draftRef = create.draftRef as Hash;
    const createArgs = (ref: Hash) =>
      [
        BigInt(create.rewardPerCompletion!),
        Number(create.maxCompletions),
        BigInt(create.startTime!),
        BigInt(create.endTime!),
        ref,
      ] as const;
    const node = http(RPC_URL)({ chain: anvil });
    let lostHash: Hash | null = null;
    const lossyWallet = createWalletClient({
      account: advertiser,
      chain: anvil,
      transport: custom({
        async request({ method, params }) {
          const result = await node.request({ method, params });
          if (method === "eth_sendRawTransaction") {
            lostHash = result as Hash;
            throw new Error("simulated timeout: response lost after broadcast");
          }
          return result;
        },
      }),
    });
    const linkByDraft = () =>
      app.inject({
        method: "POST",
        url: `/v1/campaigns/${campaignId}/onchain`,
        headers: auth,
        payload: {},
      });
    const linkByHash = (txHash: Hash) =>
      app.inject({
        method: "POST",
        url: `/v1/campaigns/${campaignId}/onchain`,
        headers: auth,
        payload: { txHash },
      });

    await testClient.setAutomine(false);
    await expect(
      lossyWallet.writeContract({
        address: managerAddress,
        abi: manager.abi,
        functionName: "createCampaign",
        args: createArgs(draftRef),
      }),
    ).rejects.toThrow(/response lost after broadcast/);
    expect(lostHash).not.toBeNull();

    // Still in the mempool: linking by draft is "reconciling", not failed.
    const beforeMined = await linkByDraft();
    expect(beforeMined.statusCode).toBe(202);
    expect(beforeMined.json()).toMatchObject({
      status: "reconciling",
      code: "NOT_CREATED_YET",
    });

    // A second tab sends the same draft again. A wallet that simulates first
    // already refuses (the lost transaction is pending); one that estimated
    // gas before the first broadcast still sends it, and the contract must
    // refuse it on-chain.
    await expect(
      publicClient.simulateContract({
        account: advertiser,
        address: managerAddress,
        abi: manager.abi,
        functionName: "createCampaign",
        args: createArgs(draftRef),
        blockTag: "pending",
      }),
    ).rejects.toThrow(/DraftAlreadyCreated/);
    const retryHash = await wallet(advertiser).writeContract({
      address: managerAddress,
      abi: manager.abi,
      functionName: "createCampaign",
      args: createArgs(draftRef),
      gas: 500_000n,
    });
    // The same wallet also creates an identical campaign for another draft.
    const decoyHash = await wallet(advertiser).writeContract({
      address: managerAddress,
      abi: manager.abi,
      functionName: "createCampaign",
      args: createArgs(keccak256(stringToBytes("vham-draft:someone-else"))),
    });

    await testClient.mine({ blocks: 1 });
    await testClient.setAutomine(true);
    const receipt = (hash: Hash) =>
      publicClient.waitForTransactionReceipt({ hash });
    expect((await receipt(lostHash!)).status).toBe("success");
    // The contract refuses a second campaign for the same draft.
    expect((await receipt(retryHash)).status).toBe("reverted");
    expect((await receipt(decoyHash)).status).toBe("success");

    // Mined but not yet final: still reconciling, never linked early.
    expect((await linkByDraft()).json()).toMatchObject({
      status: "reconciling",
      code: "NOT_CREATED_YET",
    });
    await testClient.mine({ blocks: CONFIRMATIONS });

    // Linking needs no hash: the contract knows this draft's campaign.
    const linked = await linkByDraft();
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject({ status: "pending_onchain" });
    const onchainId = BigInt(
      linked.json<{ onchainCampaignId: string }>().onchainCampaignId,
    );
    expect(
      await publicClient.readContract({
        address: managerAddress,
        abi: manager.abi,
        functionName: "campaignIdByDraft",
        args: [advertiser.address, draftRef],
      }),
    ).toBe(onchainId);

    // Idempotent, and the other transactions can never be linked here.
    expect((await linkByDraft()).statusCode).toBe(200);
    expect((await linkByHash(lostHash!)).statusCode).toBe(200);
    expect((await linkByHash(decoyHash)).json()).toMatchObject({
      error: { code: "DRAFT_MISMATCH" },
    });
    expect((await linkByHash(retryHash)).json()).toMatchObject({
      error: { code: "TX_REVERTED" },
    });

    // Exactly one creation carries this draft's reference.
    const creations = await publicClient.getContractEvents({
      address: managerAddress,
      abi: manager.abi,
      eventName: "CampaignCreated",
      args: { draftRef },
      fromBlock: 0n,
    });
    expect(creations).toHaveLength(1);

    // A hash the node has never seen (dropped or not yet propagated) is also
    // "reconciling", never a failure that would make the advertiser create
    // and fund a duplicate campaign.
    const otherDraft = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { ...auth, "idempotency-key": "e2e-campaign-unmined" },
      payload: {
        ...campaignBody,
        contentUrl: "https://example.com/e2e-unmined",
      },
    });
    const unknown = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${otherDraft.json<{ id: string }>().id}/onchain`,
      headers: auth,
      payload: { txHash: `0x${"ab".repeat(32)}` },
    });
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toMatchObject({ status: "reconciling" });

    // 3. Fund; the campaign becomes active only from confirmed events.
    await send(advertiser, usdcAddress, mockUsdc.abi, "approve", [
      managerAddress,
      10n * USDC,
    ]);
    await send(advertiser, managerAddress, manager.abi, "fundCampaign", [
      onchainId,
      10n * USDC,
      draftRefFor(campaignId),
    ]);
    await reconcile();

    const afterFunding = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/analytics`,
      headers: auth,
    });
    expect(afterFunding.json()).toMatchObject({
      status: "active",
      settlement: { confirmed: { funded: "10000000", paidRewards: "0" } },
    });

    // 4. A verified human completes the mission after start.
    await travelTo(seconds(130));
    const aliceProof = await simulatedProof(campaignId, alice.address, "alice");
    const verified = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/eligibility/verify`,
      payload: { claimant: alice.address, idkitResponse: aliceProof },
    });
    expect(verified.statusCode).toBe(201);
    const eligibilityToken = verified.json<{ eligibilityToken: string }>()
      .eligibilityToken;

    // Alice's proof is bound to her wallet: relayed for Bob's, it is refused
    // and nothing is written (Bob verifies with his own proof in step 8).
    const relayed = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/eligibility/verify`,
      payload: { claimant: bob.address, idkitResponse: aliceProof },
    });
    expect(relayed.statusCode).toBe(403);
    expect(relayed.json()).toMatchObject({
      error: { code: "SIGNAL_MISMATCH" },
    });

    const submitted = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/submissions`,
      headers: { "idempotency-key": "alice-1" },
      payload: {
        eligibilityToken,
        claimant: alice.address,
        answers: [{ questionId: "q1", choiceId: "a" }],
      },
    });
    // The authorization is signed in the same request as the acceptance
    // (ADR-0011), so a later close cannot strand an accepted completion.
    expect(submitted.json()).toMatchObject({
      status: "accepted",
      claim: { status: "authorized" },
    });
    const submissionId = submitted.json<{ submissionId: string }>()
      .submissionId;
    const issuedAtAcceptance = submitted.json<{
      claim: { authorization: { nonce: Hex } };
    }>().claim.authorization;

    // The same human cannot complete twice.
    const again = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/submissions`,
      headers: { "idempotency-key": "alice-2" },
      payload: {
        eligibilityToken,
        claimant: alice.address,
        answers: [{ questionId: "q1", choiceId: "a" }],
      },
    });
    expect(again.statusCode).toBe(409);

    // 5. EIP-712 authorization from the backend signer: requesting it again
    // returns the one issued at acceptance.
    const authorization = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/submissions/${submissionId}/authorization`,
      payload: { eligibilityToken },
    });
    expect(authorization.statusCode).toBe(200);
    const claim = authorization.json<{
      campaignId: string;
      draftRef: Hex;
      claimant: Address;
      amount: string;
      nonce: Hex;
      issuedAt: number;
      expiresAt: number;
      signature: Hex;
    }>();
    expect(claim.nonce).toBe(issuedAtAcceptance.nonce);
    expect(claim.draftRef).toBe(draftRef);
    const toClaimArgs = (signed: typeof claim) => [
      {
        campaignId: BigInt(signed.campaignId),
        draftRef: signed.draftRef,
        claimant: signed.claimant,
        amount: BigInt(signed.amount),
        nonce: signed.nonce,
        issuedAt: BigInt(signed.issuedAt),
        expiresAt: BigInt(signed.expiresAt),
      },
      signed.signature,
    ];
    const claimArgs = toClaimArgs(claim);

    // 5b. Emergency drills (#23, docs/operations/RUNBOOK.md).
    const simulateClaim = () =>
      publicClient.simulateContract({
        account: alice,
        address: managerAddress,
        abi: manager.abi,
        functionName: "claim",
        args: claimArgs,
      });
    // Pause: every claim stops; unpause restores them.
    await send(deployer, managerAddress, manager.abi, "pause", []);
    await expect(simulateClaim()).rejects.toThrow();
    await send(deployer, managerAddress, manager.abi, "unpause", []);
    // Signer rotation: outstanding signatures stop verifying and the API
    // refuses to sign with a key the contract no longer trusts.
    const rotatedSigner = mnemonicToAccount(MNEMONIC, { addressIndex: 6 });
    await send(deployer, managerAddress, manager.abi, "setAuthorizedSigner", [
      rotatedSigner.address,
    ]);
    await expect(simulateClaim()).rejects.toThrow();
    const mismatch = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/submissions/${submissionId}/authorization`,
      payload: { eligibilityToken },
    });
    expect(mismatch.json()).toMatchObject({
      error: { code: "SIGNER_MISMATCH" },
    });
    await send(deployer, managerAddress, manager.abi, "setAuthorizedSigner", [
      claimSignerAccount.address,
    ]);
    await expect(simulateClaim()).resolves.toBeDefined();

    // 6. The participant claims exactly 1 USDC on-chain.
    await send(alice, managerAddress, manager.abi, "claim", claimArgs);
    expect(
      await publicClient.readContract({
        address: usdcAddress,
        abi: mockUsdc.abi,
        functionName: "balanceOf",
        args: [alice.address],
      }),
    ).toBe(USDC);

    // A duplicate on-chain claim reverts.
    await expect(
      publicClient.simulateContract({
        account: alice,
        address: managerAddress,
        abi: manager.abi,
        functionName: "claim",
        args: claimArgs,
      }),
    ).rejects.toThrow();

    // 7. Indexer reconciliation matches the chain.
    await reconcile();
    const onchain = await readOnchainCampaign(
      new JsonRpcClient(RPC_URL),
      managerAddress.toLowerCase(),
      onchainId.toString(),
    );
    const mid = (
      await app.inject({
        method: "GET",
        url: `/v1/campaigns/${campaignId}/analytics`,
        headers: auth,
      })
    ).json<{
      submissions: { accepted: number };
      settlement: {
        confirmed: { paidRewards: string; paidCompletions: number };
      };
    }>();
    expect(mid.submissions.accepted).toBe(1);
    expect(mid.settlement.confirmed.paidRewards).toBe(onchain!.paidRewards);
    expect(mid.settlement.confirmed.paidCompletions).toBe(
      onchain!.paidCompletions,
    );

    // 8. Close: a completion accepted before the close stays payable; none
    // is accepted after it; refund only after the grace period.
    await travelTo(seconds(10));
    const bobVerified = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/eligibility/verify`,
      payload: {
        claimant: bob.address,
        idkitResponse: await simulatedProof(campaignId, bob.address, "bob"),
      },
    });
    expect(bobVerified.statusCode).toBe(201);
    const bobToken = bobVerified.json<{ eligibilityToken: string }>()
      .eligibilityToken;
    const bobSubmission = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/submissions`,
      headers: { "idempotency-key": "bob-1" },
      payload: {
        eligibilityToken: bobToken,
        claimant: bob.address,
        answers: [{ questionId: "q1", choiceId: "a" }],
      },
    });
    expect(bobSubmission.json()).toMatchObject({
      status: "accepted",
      claim: { status: "authorized" },
    });
    const bobClaim = bobSubmission.json<{
      claim: { authorization: typeof claim };
    }>().claim.authorization;

    await travelTo(seconds(10));
    await send(advertiser, managerAddress, manager.abi, "closeCampaign", [
      onchainId,
    ]);
    const closedAt = clock;

    // Bob was accepted before the close, so his authorization still pays.
    await send(
      bob,
      managerAddress,
      manager.abi,
      "claim",
      toClaimArgs(bobClaim),
    );
    expect(
      await publicClient.readContract({
        address: usdcAddress,
        abi: mockUsdc.abi,
        functionName: "balanceOf",
        args: [bob.address],
      }),
    ).toBe(USDC);

    // The close is not confirmed by the indexer yet, so the database still
    // says "active". The submission service reads the contract live and
    // accepts no completion the contract would not pay.
    const carolVerified = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/eligibility/verify`,
      payload: {
        claimant: carol.address,
        idkitResponse: await simulatedProof(campaignId, carol.address, "carol"),
      },
    });
    expect(carolVerified.statusCode).toBe(201);
    const carolSubmission = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/submissions`,
      headers: { "idempotency-key": "carol-1" },
      payload: {
        eligibilityToken: carolVerified.json<{ eligibilityToken: string }>()
          .eligibilityToken,
        claimant: carol.address,
        answers: [{ questionId: "q1", choiceId: "a" }],
      },
    });
    expect(carolSubmission.statusCode).toBe(409);
    expect(carolSubmission.json()).toMatchObject({
      error: { code: "CAMPAIGN_NOT_ACTIVE" },
    });

    await expect(
      publicClient.simulateContract({
        account: advertiser,
        address: managerAddress,
        abi: manager.abi,
        functionName: "refundUnusedBudget",
        args: [onchainId],
      }),
    ).rejects.toThrow();

    await travelTo(new Date(closedAt.getTime() + 15 * 60_000 + 5_000));
    const balanceBefore = (await publicClient.readContract({
      address: usdcAddress,
      abi: mockUsdc.abi,
      functionName: "balanceOf",
      args: [advertiser.address],
    })) as bigint;
    await send(advertiser, managerAddress, manager.abi, "refundUnusedBudget", [
      onchainId,
    ]);
    const balanceAfter = (await publicClient.readContract({
      address: usdcAddress,
      abi: mockUsdc.abi,
      functionName: "balanceOf",
      args: [advertiser.address],
    })) as bigint;
    expect(balanceAfter - balanceBefore).toBe(8n * USDC);

    // 9. Final reconciliation: settled, and accounting balances exactly.
    await reconcile();
    const final = (
      await app.inject({
        method: "GET",
        url: `/v1/campaigns/${campaignId}/analytics`,
        headers: auth,
      })
    ).json();
    expect(final).toMatchObject({
      status: "settled",
      settlement: {
        confirmed: {
          status: "settled",
          funded: "10000000",
          paidRewards: "2000000",
          refunded: "8000000",
          remaining: "0",
          paidCompletions: 2,
          accountingViolation: false,
        },
        hasUnconfirmedEvents: false,
      },
    });

    // Independent reconciliation agrees: no mismatches, no unbacked payouts.
    expect(await checkSettlement()).toMatchObject({
      campaignsChecked: 1,
      findings: [],
    });
  }, 120_000);
});
