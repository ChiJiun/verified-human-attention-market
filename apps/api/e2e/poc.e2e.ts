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
  defineChain,
  http,
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
  readOnchainCampaign,
  syncCampaignStatuses,
} from "../src/campaigns/onchain.js";
import { PostgresCampaignRepository } from "../src/campaigns/repository.js";
import { PostgresChainEventRepository } from "../src/chain/events-repository.postgres.js";
import { indexOnce } from "../src/chain/indexer.js";
import { JsonRpcClient } from "../src/chain/rpc.js";
import { PostgresClaimRepository } from "../src/claims/repository.js";
import { createClaimSigner } from "../src/claims/signer.js";
import { createDatabase } from "../src/db/client.js";
import { PostgresEligibilityRepository } from "../src/eligibility/repository.js";
import { PostgresModerationRepository } from "../src/moderation/repository.js";
import {
  campaignAction,
  type WorldIdResult,
  type WorldIdVerifier,
} from "../src/identity/world-id.js";
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

function artifact(path: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(
    readFileSync(
      new URL(`../../../packages/contracts/out/${path}`, import.meta.url),
      "utf8",
    ),
  ) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

/** World ID needs the World App; the proof is simulated as { action, human }. */
class SimulatedWorldId implements WorldIdVerifier {
  async verify(request: {
    action: string;
    idkitResponse: unknown;
  }): Promise<WorldIdResult> {
    const proof = request.idkitResponse as { action: string; human: string };
    return proof.action === request.action
      ? {
          ok: true,
          nullifier: String(
            BigInt(`0x${Buffer.from(proof.human).toString("hex")}`),
          ),
        }
      : { ok: false, code: "ACTION_MISMATCH" };
  }
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

  /** Moves chain time and the API clock together. */
  async function travelTo(date: Date) {
    await testClient.setNextBlockTimestamp({
      timestamp: BigInt(Math.floor(date.getTime() / 1000)),
    });
    await testClient.mine({ blocks: 1 });
    clock = date;
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
      worldIdVerifier: new SimulatedWorldId(),
      participantKeySecret: "e2e-participant-key-secret-0123456789",
      chainId: anvil.id,
      chain: { rpc, chain, events: eventRepository, now },
      // Production moderation: an operator must approve the campaign.
      moderationRepository: new PostgresModerationRepository(database.db),
      moderation: {
        mode: "review",
        operators: [operator.address.toLowerCase()],
        advertiserAllowlist: [],
      },
      now,
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
    const createHash = await send(
      advertiser,
      managerAddress,
      manager.abi,
      "createCampaign",
      [
        BigInt(create.rewardPerCompletion!),
        Number(create.maxCompletions),
        BigInt(create.startTime!),
        BigInt(create.endTime!),
      ],
    );

    const linked = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/onchain`,
      headers: auth,
      payload: { txHash: createHash },
    });
    expect(linked.json()).toMatchObject({ status: "pending_onchain" });
    const onchainId = BigInt(
      linked.json<{ onchainCampaignId: string }>().onchainCampaignId,
    );

    // Simulated RPC timeout after broadcast: the hash is not (yet) known to
    // the node. The API answers "reconciling", never a failure that would make
    // the advertiser create and fund a duplicate campaign.
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
    const verified = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/eligibility/verify`,
      payload: {
        claimant: alice.address,
        idkitResponse: { action: campaignAction(campaignId), human: "alice" },
      },
    });
    expect(verified.statusCode).toBe(201);
    const eligibilityToken = verified.json<{ eligibilityToken: string }>()
      .eligibilityToken;

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
    expect(submitted.json()).toMatchObject({ status: "accepted" });
    const submissionId = submitted.json<{ submissionId: string }>()
      .submissionId;

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

    // 5. EIP-712 authorization from the backend signer.
    const authorization = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/submissions/${submissionId}/authorization`,
      payload: { eligibilityToken },
    });
    expect(authorization.statusCode).toBe(201);
    const claim = authorization.json<{
      campaignId: string;
      claimant: Address;
      amount: string;
      nonce: Hex;
      issuedAt: number;
      expiresAt: number;
      signature: Hex;
    }>();
    const claimArgs = [
      {
        campaignId: BigInt(claim.campaignId),
        claimant: claim.claimant,
        amount: BigInt(claim.amount),
        nonce: claim.nonce,
        issuedAt: BigInt(claim.issuedAt),
        expiresAt: BigInt(claim.expiresAt),
      },
      claim.signature,
    ];

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

    // 8. Close: no new liability after close, refund only after the grace period.
    await travelTo(seconds(10));
    await send(advertiser, managerAddress, manager.abi, "closeCampaign", [
      onchainId,
    ]);
    const closedAt = clock;

    const bobVerified = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/eligibility/verify`,
      payload: {
        claimant: bob.address,
        idkitResponse: { action: campaignAction(campaignId), human: "bob" },
      },
    });
    // The close is not confirmed by the indexer yet, so the database still
    // says "active" and Bob's completion is accepted. No liability results:
    // the claim service reads closedAt live from the contract and refuses.
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
    expect(bobSubmission.json()).toMatchObject({ status: "accepted" });
    const bobAuth = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/submissions/${bobSubmission.json<{ submissionId: string }>().submissionId}/authorization`,
      payload: { eligibilityToken: bobToken },
    });
    expect(bobAuth.json()).toMatchObject({
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
    expect(balanceAfter - balanceBefore).toBe(9n * USDC);

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
          paidRewards: "1000000",
          refunded: "9000000",
          remaining: "0",
          paidCompletions: 1,
          accountingViolation: false,
        },
        hasUnconfirmedEvents: false,
      },
    });
  }, 120_000);
});
