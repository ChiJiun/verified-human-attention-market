import { draftRefFor } from "../src/campaigns/onchain.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  IdempotencyConflictError,
  PostgresCampaignRepository,
} from "../src/campaigns/repository.js";
import { PostgresAuthRepository } from "../src/auth/repository.js";
import { PostgresClaimRepository } from "../src/claims/repository.js";
import { createClaimSigner } from "../src/claims/signer.js";
import { createDatabase } from "../src/db/client.js";
import {
  answers,
  campaigns,
  eligibility,
  missions,
  submissions,
} from "../src/db/schema.js";
import { PostgresChainEventRepository } from "../src/chain/events-repository.postgres.js";
import {
  hashMissionDefinition,
  toMissionDefinition,
} from "../src/missions/schemas.js";
import { PostgresEligibilityRepository } from "../src/eligibility/repository.js";
import {
  ModerationError,
  PostgresModerationRepository,
} from "../src/moderation/repository.js";
import { applyRetention, eraseWallet } from "../src/privacy/retention.js";
import {
  hashSubmissionRequest,
  PostgresSubmissionRepository,
} from "../src/submissions/repository.js";
import { defineIndexerContract } from "./support/indexer-contract.js";
import { definePersistenceContract } from "./support/persistence-contract.js";

/** CampaignManager the integration tests link campaigns to. */
const CONTRACT_ADDRESS = `0x${"2".repeat(40)}`;

const databaseUrl = process.env.TEST_DATABASE_URL;

function testMission(contentUrl = "https://example.com/postgres") {
  const definition = toMissionDefinition(contentUrl, {
    questions: [
      {
        id: "q1",
        prompt: "What is the product name?",
        choices: [
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
        ],
      },
    ],
    answerKey: { q1: "a" },
  });

  return {
    id: randomUUID(),
    definition,
    definitionHash: hashMissionDefinition(definition),
  };
}
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("PostgresCampaignRepository", () => {
  if (!databaseUrl) {
    return;
  }

  const database = createDatabase(databaseUrl);
  const repository = new PostgresCampaignRepository(database.db);

  // TRUNCATE: row triggers forbid deleting submissions and audit entries.
  async function truncateAll() {
    await database.db.execute(
      sql`TRUNCATE answers, submissions, eligibility, moderation_actions, campaign_reports, campaign_moderation, missions, campaigns, chain_events, reconciliation_state, auth_nonces, auth_sessions`,
    );
  }

  beforeAll(async () => {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });

    await truncateAll();
  });

  afterAll(async () => {
    await truncateAll();
    await database.close();
  });

  it("persists and reloads a campaign", async () => {
    const id = randomUUID();
    const createdAt = new Date("2026-10-05T10:00:00.000Z");

    const result = await repository.createIdempotent({
      id,
      chainId: 84532,
      advertiserAddress: "0x1234567890abcdef1234567890abcdef12345678",
      creationIdempotencyKey: "postgres-create-1",
      creationRequestHash: "hash-1",
      contentUrl: "https://example.com/postgres",
      rewardAtomic: "1000000",
      maxCompletions: 10,
      startAt: new Date("2026-10-05T10:15:00.000Z"),
      endAt: new Date("2026-10-05T11:15:00.000Z"),
      status: "draft",
      createdAt,
      updatedAt: createdAt,
      mission: testMission(),
    });

    expect(result.created).toBe(true);
    expect(result.campaign.id).toBe(id);
    expect(result.campaign.rewardAtomic).toBe("1000000");

    const loaded = await repository.getById(id);

    expect(loaded).toMatchObject({
      id,
      chainId: 84532,
      rewardAtomic: "1000000",
      maxCompletions: 10,
      status: "draft",
    });
  });

  it("preserves idempotency in PostgreSQL", async () => {
    const createdAt = new Date("2026-10-05T10:00:00.000Z");
    const baseInput = {
      id: randomUUID(),
      chainId: 84532,
      advertiserAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      creationIdempotencyKey: "postgres-idempotency",
      creationRequestHash: "same-request-hash",
      contentUrl: "https://example.com/idempotency",
      rewardAtomic: "1000000",
      maxCompletions: 10,
      startAt: new Date("2026-10-05T10:15:00.000Z"),
      endAt: new Date("2026-10-05T11:15:00.000Z"),
      status: "draft" as const,
      createdAt,
      updatedAt: createdAt,
      mission: testMission(),
    };

    const first = await repository.createIdempotent(baseInput);
    const second = await repository.createIdempotent({
      ...baseInput,
      id: randomUUID(),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.campaign.id).toBe(first.campaign.id);

    await expect(
      repository.createIdempotent({
        ...baseInput,
        id: randomUUID(),
        creationRequestHash: "different-request-hash",
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("responds to the readiness ping after migration", async () => {
    await expect(repository.ping()).resolves.toBeUndefined();
  });

  it("refuses to delete a campaign that has eligibility records", async () => {
    const campaignId = await createCampaign();
    await new PostgresEligibilityRepository(database.db).recordIdempotent({
      id: randomUUID(),
      campaignId,
      participantKey: "f".repeat(64),
      claimantAddress: "0x" + "1".repeat(40),
      provider: "world_id",
      verifiedAt: new Date("2026-10-05T10:20:00.000Z"),
      expiresAt: new Date("2026-10-05T11:20:00.000Z"),
    });

    await expect(
      database.db.delete(campaigns).where(eq(campaigns.id, campaignId)),
    ).rejects.toThrow();
  });

  async function createCampaign(): Promise<string> {
    const id = randomUUID();
    const createdAt = new Date("2026-10-05T10:00:00.000Z");

    await repository.createIdempotent({
      id,
      chainId: 84532,
      advertiserAddress: "0x" + "2".repeat(40),
      creationIdempotencyKey: `contract-${id}`,
      creationRequestHash: `hash-${id}`,
      contentUrl: "https://example.com/contract",
      rewardAtomic: "1000000",
      maxCompletions: 10,
      startAt: new Date("2026-10-05T10:15:00.000Z"),
      endAt: new Date("2026-10-05T11:15:00.000Z"),
      status: "draft",
      createdAt,
      updatedAt: createdAt,
      mission: testMission(),
    });

    return id;
  }

  async function missionIdFor(campaignId: string): Promise<string> {
    const mission = await repository.getMission(campaignId);

    if (!mission) {
      throw new Error("Campaign has no mission");
    }

    return mission.id;
  }

  it("stores the mission atomically and keeps it immutable", async () => {
    const campaignId = await createCampaign();
    const mission = await repository.getMission(campaignId);

    expect(mission).toMatchObject({
      campaignId,
      version: 1,
      kind: "comprehension_check",
      answerKey: { q1: "a" },
      passThreshold: 1,
    });

    await expect(
      database.db
        .update(missions)
        .set({ answerKey: { q1: "b" } })
        .where(eq(missions.campaignId, campaignId)),
    ).rejects.toThrow();
  });

  describe("eligibility + submission persistence", () => {
    const eligibilityRepository = new PostgresEligibilityRepository(
      database.db,
    );

    definePersistenceContract(() => ({
      eligibility: eligibilityRepository,
      submissions: new PostgresSubmissionRepository(database.db),
      createCampaign,
      missionIdFor,
    }));
  });

  it("keeps on-chain ids of different deployments apart (ADR-0011)", async () => {
    // Ids restart at 1 on every CampaignManager deployment.
    const oldContract = `0x${"a".repeat(40)}`;
    const oldDraft = await createCampaign();
    const newDraft = await createCampaign();
    const link = (id: string, contractAddress: string) =>
      repository.linkOnchain(id, {
        onchainCampaignId: "1",
        contractAddress,
        publishTxHash: null,
        status: "pending_onchain",
        updatedAt: new Date("2026-10-05T10:20:00.000Z"),
      });

    await link(oldDraft, oldContract);
    await link(newDraft, CONTRACT_ADDRESS);

    expect(
      (await repository.findByOnchainId(84532, oldContract, "1"))?.id,
    ).toBe(oldDraft);
    expect(
      (await repository.findByOnchainId(84532, CONTRACT_ADDRESS, "1"))?.id,
    ).toBe(newDraft);
    expect(
      (await repository.listLinked(84532, CONTRACT_ADDRESS)).map((c) => c.id),
    ).toEqual([newDraft]);
    // The same deployment still allows one draft per on-chain id.
    await expect(
      link(await createCampaign(), CONTRACT_ADDRESS),
    ).rejects.toThrow(/ONCHAIN_CAMPAIGN_ALREADY_LINKED/);
  });

  it("persists one signed claim under concurrent retries", async () => {
    const campaignId = await createCampaign();
    await repository.linkOnchain(campaignId, {
      onchainCampaignId: "7",
      contractAddress: CONTRACT_ADDRESS,
      publishTxHash: `0x${"a".repeat(64)}`,
      status: "active",
      updatedAt: new Date("2026-10-05T10:20:00.000Z"),
    });
    const claimantAddress = `0x${"3".repeat(40)}`;
    const eligibilityRecord = await new PostgresEligibilityRepository(
      database.db,
    ).recordIdempotent({
      id: randomUUID(),
      campaignId,
      participantKey: "e".repeat(64),
      claimantAddress,
      provider: "world_id",
      verifiedAt: new Date("2026-10-05T10:20:00.000Z"),
      expiresAt: new Date("2026-10-05T11:20:00.000Z"),
    });
    const answers = [{ questionId: "q1", normalizedAnswer: "a", score: "1" }];
    const submissionRecord = await new PostgresSubmissionRepository(
      database.db,
    ).recordIdempotent({
      id: randomUUID(),
      campaignId,
      eligibilityId: eligibilityRecord.eligibility.id,
      missionId: await missionIdFor(campaignId),
      idempotencyKey: randomUUID(),
      requestHash: hashSubmissionRequest({
        campaignId,
        claimantAddress,
        answers,
      }),
      claimantAddress,
      result: "accepted",
      rejectionCode: null,
      answers,
      createdAt: new Date("2026-10-05T10:30:00.000Z"),
    });
    const signer = createClaimSigner(`0x${"11".repeat(32)}`);
    const claims = new PostgresClaimRepository(database.db);
    const now = new Date("2026-10-05T10:31:00.000Z");
    const input = {
      campaignId,
      submissionId: submissionRecord.submission.id,
      now,
      canIssue: true,
      alreadyClaimed: false,
      onchainPaidCompletions: 0,
      sign: () =>
        signer.sign({
          campaignId: 7n,
          draftRef: draftRefFor(campaignId),
          claimant: claimantAddress as `0x${string}`,
          amount: 1000000n,
          chainId: 84532,
          contractAddress: `0x${"2".repeat(40)}`,
          issuedAt: BigInt(Math.floor(now.getTime() / 1000)),
        }),
    };
    const [first, second] = await Promise.all([
      claims.issueOnce(input),
      claims.issueOnce(input),
    ]);
    expect(first.claim.signature).toBe(second.claim.signature);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    const [saved] = await database.db
      .select()
      .from(submissions)
      .where(eq(submissions.id, input.submissionId));
    expect(saved?.claimSignature).toBe(first.claim.signature);
    expect(saved?.claimNonce).toBe(first.claim.payload.nonce);
  });

  it("does not count a confirmed payout as outstanding liability", async () => {
    const createdAt = new Date("2026-10-05T10:00:00.000Z");
    const campaignId = randomUUID();
    await repository.createIdempotent({
      id: campaignId,
      chainId: 84532,
      advertiserAddress: "0x" + "2".repeat(40),
      creationIdempotencyKey: `cap-${campaignId}`,
      creationRequestHash: `hash-${campaignId}`,
      contentUrl: "https://example.com/cap",
      rewardAtomic: "1000000",
      maxCompletions: 2,
      startAt: new Date("2026-10-05T10:15:00.000Z"),
      endAt: new Date("2026-10-05T11:15:00.000Z"),
      status: "draft",
      createdAt,
      updatedAt: createdAt,
      mission: testMission("https://example.com/cap"),
    });
    await repository.linkOnchain(campaignId, {
      onchainCampaignId: "8",
      contractAddress: CONTRACT_ADDRESS,
      publishTxHash: `0x${"b".repeat(64)}`,
      status: "active",
      updatedAt: new Date("2026-10-05T10:20:00.000Z"),
    });

    const eligibilityRepository = new PostgresEligibilityRepository(
      database.db,
    );
    const submissionRepository = new PostgresSubmissionRepository(database.db);
    const missionId = await missionIdFor(campaignId);
    const acceptedSubmission = async (digit: string) => {
      const claimantAddress = `0x${digit.repeat(40)}`;
      const { eligibility: record } =
        await eligibilityRepository.recordIdempotent({
          id: randomUUID(),
          campaignId,
          participantKey: digit.repeat(64),
          claimantAddress,
          provider: "world_id",
          verifiedAt: new Date("2026-10-05T10:20:00.000Z"),
          expiresAt: new Date("2026-10-05T11:15:00.000Z"),
        });
      const answers = [{ questionId: "q1", normalizedAnswer: "a", score: "1" }];
      const { submission } = await submissionRepository.recordIdempotent({
        id: randomUUID(),
        campaignId,
        eligibilityId: record.id,
        missionId,
        idempotencyKey: randomUUID(),
        requestHash: hashSubmissionRequest({
          campaignId,
          claimantAddress,
          answers,
        }),
        claimantAddress,
        result: "accepted",
        rejectionCode: null,
        answers,
        createdAt: new Date("2026-10-05T10:30:00.000Z"),
      });
      return { submissionId: submission.id, claimantAddress };
    };

    const signer = createClaimSigner(`0x${"11".repeat(32)}`);
    const claims = new PostgresClaimRepository(database.db);
    const now = new Date("2026-10-05T10:31:00.000Z");
    const issue = (
      target: { submissionId: string; claimantAddress: string },
      paid: number,
      redeemedNonces?: Set<string>,
    ) =>
      claims.issueOnce({
        campaignId,
        submissionId: target.submissionId,
        now,
        canIssue: true,
        alreadyClaimed: false,
        onchainPaidCompletions: paid,
        ...(redeemedNonces ? { redeemedNonces } : {}),
        sign: () =>
          signer.sign({
            campaignId: 8n,
            draftRef: draftRefFor(campaignId),
            claimant: target.claimantAddress as `0x${string}`,
            amount: 1000000n,
            chainId: 84532,
            contractAddress: CONTRACT_ADDRESS as `0x${string}`,
            issuedAt: BigInt(Math.floor(now.getTime() / 1000)),
          }),
      });

    // Wallets unique in this shared test database: the retention tests
    // count every campaign a wallet appears in.
    const first = await acceptedSubmission("a");
    const second = await acceptedSubmission("b");
    const firstClaim = await issue(first, 0);
    expect(firstClaim.created).toBe(true);

    // The first wallet was paid on-chain, but its signature is unexpired:
    // without the indexed payout it is counted twice (safe side).
    await expect(issue(second, 1)).rejects.toMatchObject({
      code: "CAMPAIGN_CAP_REACHED",
    });

    // With the confirmed payout known, the slot is free immediately.
    const secondClaim = await issue(
      second,
      1,
      new Set([firstClaim.claim.payload.nonce.toLowerCase()]),
    );
    expect(secondClaim.created).toBe(true);
    expect(secondClaim.claim.payload.nonce).not.toBe(
      firstClaim.claim.payload.nonce,
    );
  });

  /** A verified participant of `campaignId`; `digit` must be unique per test. */
  async function participantOf(campaignId: string, digit: string) {
    const claimantAddress = `0x${digit.repeat(40)}`;
    const { eligibility: record } = await new PostgresEligibilityRepository(
      database.db,
    ).recordIdempotent({
      id: randomUUID(),
      campaignId,
      participantKey: digit.repeat(64),
      claimantAddress,
      provider: "world_id",
      verifiedAt: new Date("2026-10-05T10:20:00.000Z"),
      expiresAt: new Date("2026-10-05T11:15:00.000Z"),
    });
    const answers = [{ questionId: "q1", normalizedAnswer: "a", score: "1" }];
    const accepted = {
      campaignId,
      eligibilityId: record.id,
      missionId: await missionIdFor(campaignId),
      idempotencyKey: randomUUID(),
      requestHash: hashSubmissionRequest({
        campaignId,
        claimantAddress,
        answers,
      }),
      claimantAddress,
      result: "accepted" as const,
      rejectionCode: null,
      answers,
      createdAt: new Date("2026-10-05T10:30:00.000Z"),
    };
    return { eligibilityId: record.id, claimantAddress, accepted };
  }

  it("stores an acceptance only together with its authorization (ADR-0011)", async () => {
    const campaignId = await createCampaign();
    await repository.linkOnchain(campaignId, {
      onchainCampaignId: "7",
      contractAddress: CONTRACT_ADDRESS,
      publishTxHash: null,
      status: "active",
      updatedAt: new Date("2026-10-05T10:20:00.000Z"),
    });
    const { eligibilityId, claimantAddress, accepted } = await participantOf(
      campaignId,
      "c",
    );
    const submissionRepository = new PostgresSubmissionRepository(database.db);
    const claims = new PostgresClaimRepository(database.db);
    const signer = createClaimSigner(`0x${"11".repeat(32)}`);
    const now = new Date("2026-10-05T10:31:00.000Z");

    // The authorization is refused (e.g. the campaign closed in between):
    // the whole insert rolls back and the attempt is not consumed.
    await expect(
      submissionRepository.recordIdempotent({
        ...accepted,
        id: randomUUID(),
        beforeCommit: async () => {
          throw new Error("CAMPAIGN_NOT_ACTIVE");
        },
      }),
    ).rejects.toThrow("CAMPAIGN_NOT_ACTIVE");
    expect(
      await submissionRepository.findByIdempotencyKey(
        campaignId,
        accepted.idempotencyKey,
      ),
    ).toBeNull();
    expect(await submissionRepository.countByEligibility(eligibilityId)).toBe(
      0,
    );

    // Signed inside the same transaction: the claim repository sees the
    // uncommitted row and both are committed together.
    let issued: Awaited<ReturnType<typeof claims.issueOnce>> | null = null;
    const { submission } = await submissionRepository.recordIdempotent({
      ...accepted,
      id: randomUUID(),
      beforeCommit: async (record, scope) => {
        issued = await claims.within(scope).issueOnce({
          campaignId,
          submissionId: record.id,
          now,
          canIssue: true,
          alreadyClaimed: false,
          onchainPaidCompletions: 0,
          sign: () =>
            signer.sign({
              campaignId: 7n,
              draftRef: draftRefFor(campaignId),
              claimant: claimantAddress as `0x${string}`,
              amount: 1000000n,
              chainId: 84532,
              contractAddress: CONTRACT_ADDRESS as `0x${string}`,
              issuedAt: BigInt(Math.floor(now.getTime() / 1000)),
            }),
        });
      },
    });
    expect(issued).not.toBeNull();
    const [saved] = await database.db
      .select()
      .from(submissions)
      .where(eq(submissions.id, submission.id));
    expect(saved).toMatchObject({
      result: "accepted",
      claimNonce: issued!.claim.payload.nonce,
      claimOnchainCampaignId: "7",
      claimContractAddress: CONTRACT_ADDRESS,
    });
    expect(await submissionRepository.countByEligibility(eligibilityId)).toBe(
      1,
    );
  });

  it("reissues an authorization signed for a previous on-chain id (ADR-0011)", async () => {
    const campaignId = await createCampaign();
    await repository.linkOnchain(campaignId, {
      onchainCampaignId: "7",
      contractAddress: CONTRACT_ADDRESS,
      publishTxHash: null,
      status: "active",
      updatedAt: new Date("2026-10-05T10:20:00.000Z"),
    });
    const { claimantAddress, accepted } = await participantOf(campaignId, "d");
    const { submission } = await new PostgresSubmissionRepository(
      database.db,
    ).recordIdempotent({ ...accepted, id: randomUUID() });
    const claims = new PostgresClaimRepository(database.db);
    const signer = createClaimSigner(`0x${"11".repeat(32)}`);
    const now = new Date("2026-10-05T10:31:00.000Z");
    const issue = (onchainCampaignId: bigint) =>
      claims.issueOnce({
        campaignId,
        submissionId: submission.id,
        now,
        canIssue: true,
        alreadyClaimed: false,
        onchainPaidCompletions: 0,
        sign: () =>
          signer.sign({
            campaignId: onchainCampaignId,
            draftRef: draftRefFor(campaignId),
            claimant: claimantAddress as `0x${string}`,
            amount: 1000000n,
            chainId: 84532,
            contractAddress: CONTRACT_ADDRESS as `0x${string}`,
            issuedAt: BigInt(Math.floor(now.getTime() / 1000)),
          }),
      });

    const first = await issue(7n);
    expect(first.created).toBe(true);
    // Still bound to id 7: replayed, not re-signed.
    expect(await issue(7n)).toMatchObject({ created: false });

    // Recovery after a deep reorg relinks the draft to id 9.
    await database.db
      .update(campaigns)
      .set({ onchainCampaignId: "9" })
      .where(eq(campaigns.id, campaignId));

    const reissued = await issue(9n);
    expect(reissued.created).toBe(true);
    expect(reissued.claim.payload.campaignId).toBe(9n);
    expect(reissued.claim.payload.nonce).not.toBe(first.claim.payload.nonce);
    const [saved] = await database.db
      .select()
      .from(submissions)
      .where(eq(submissions.id, submission.id));
    expect(saved?.claimOnchainCampaignId).toBe("9");
    expect(saved?.claimNonce).toBe(reissued.claim.payload.nonce);
  });

  describe("chain indexer persistence", () => {
    defineIndexerContract({
      repository: () => new PostgresChainEventRepository(database.db),
    });
  });

  describe("moderation and settlement integrity (#24)", () => {
    const moderation = new PostgresModerationRepository(database.db);
    const at = new Date("2026-10-05T10:05:00.000Z");

    it("persists transitions with an append-only audit trail", async () => {
      const campaignId = await createCampaign();

      await moderation.initialize(
        campaignId,
        "pending_review",
        "system",
        "awaiting review",
        at,
      );
      // Idempotent: a replayed creation does not reset or duplicate state.
      await moderation.initialize(campaignId, "approved", "system", "x", at);
      expect((await moderation.getState(campaignId))?.status).toBe(
        "pending_review",
      );

      const report = await moderation.createReport({
        campaignId,
        reason: "phishing",
        details: null,
        at,
      });
      await moderation.applyAction({
        campaignId,
        action: "approve",
        actor: "operator:0x1",
        reason: "ok",
        reportId: null,
        at,
      });
      await moderation.applyAction({
        campaignId,
        action: "take_down",
        actor: "operator:0x1",
        reason: "confirmed phishing",
        reportId: report.id,
        at: new Date("2026-10-05T10:06:00.000Z"),
      });
      await expect(
        moderation.applyAction({
          campaignId,
          action: "reject",
          actor: "operator:0x1",
          reason: "late",
          reportId: null,
          at,
        }),
      ).rejects.toBeInstanceOf(ModerationError);
      await moderation.resolveReport({
        reportId: report.id,
        resolution: "actioned",
        actor: "operator:0x1",
        reason: "taken down",
        at: new Date("2026-10-05T10:07:00.000Z"),
      });

      expect((await moderation.getState(campaignId))?.status).toBe(
        "taken_down",
      );
      const actions = await moderation.listActions(campaignId);
      expect(actions.map((action) => action.action)).toEqual([
        "approve",
        "take_down",
        "resolve_report",
      ]);
      expect(
        (await moderation.listByStatus("taken_down", 10)).map(
          (state) => state.campaignId,
        ),
      ).toContain(campaignId);

      // The audit trail cannot be rewritten or removed.
      await expect(
        database.db.execute(
          sql`UPDATE moderation_actions SET reason = 'nothing happened' WHERE campaign_id = ${campaignId}`,
        ),
      ).rejects.toThrow();
      await expect(
        database.db.execute(
          sql`DELETE FROM moderation_actions WHERE campaign_id = ${campaignId}`,
        ),
      ).rejects.toThrow();
    });

    it("serializes concurrent operator actions", async () => {
      const campaignId = await createCampaign();
      const results = await Promise.allSettled(
        ["approve", "reject"].map((action) =>
          moderation.applyAction({
            campaignId,
            action: action as "approve" | "reject",
            actor: "operator:0x1",
            reason: "race",
            reportId: null,
            at,
          }),
        ),
      );
      const states = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.status] : [],
      );

      // Both from pending_review is impossible: exactly one wins, unless
      // reject ran first and approve (allowed from rejected) followed.
      const actions = await moderation.listActions(campaignId);
      expect(actions).toHaveLength(states.length);
      expect(actions[0]?.fromStatus).toBe("pending_review");
      if (actions[1]) {
        expect(actions[1].fromStatus).toBe(actions[0]?.toStatus);
      }
    });

    it("forbids rewriting or deleting submission results", async () => {
      const campaignId = await createCampaign();
      const wallet = `0x${"8".repeat(40)}`;
      const { eligibility: record } = await new PostgresEligibilityRepository(
        database.db,
      ).recordIdempotent({
        id: randomUUID(),
        campaignId,
        participantKey: "d".repeat(64),
        claimantAddress: wallet,
        provider: "world_id",
        verifiedAt: new Date("2026-10-05T10:20:00.000Z"),
        expiresAt: new Date("2026-10-05T11:20:00.000Z"),
      });
      const submissionAnswers = [
        { questionId: "q1", normalizedAnswer: "b", score: "0" },
      ];
      const { submission } = await new PostgresSubmissionRepository(
        database.db,
      ).recordIdempotent({
        id: randomUUID(),
        campaignId,
        eligibilityId: record.id,
        missionId: await missionIdFor(campaignId),
        idempotencyKey: randomUUID(),
        requestHash: hashSubmissionRequest({
          campaignId,
          claimantAddress: wallet,
          answers: submissionAnswers,
        }),
        claimantAddress: wallet,
        result: "rejected",
        rejectionCode: "BELOW_THRESHOLD",
        answers: submissionAnswers,
        createdAt: new Date("2026-10-05T10:30:00.000Z"),
      });

      await expect(
        database.db
          .update(submissions)
          .set({ result: "accepted", rejectionCode: null })
          .where(eq(submissions.id, submission.id)),
      ).rejects.toThrow();
      await expect(
        database.db
          .delete(submissions)
          .where(eq(submissions.id, submission.id)),
      ).rejects.toThrow();

      // Retention may still pseudonymize the wallet (#22).
      await database.db
        .update(submissions)
        .set({ claimantAddress: `0x${"9".repeat(40)}` })
        .where(eq(submissions.id, submission.id));
    });
  });

  describe("retention (#22)", () => {
    const eligibilityRepository = new PostgresEligibilityRepository(
      database.db,
    );
    const submissionRepository = new PostgresSubmissionRepository(database.db);
    const HEX64 = /^[0-9a-f]{64}$/;
    const ADDRESS = /^0x[0-9a-f]{40}$/;

    /** One participant with one submission (and one stored answer). */
    async function participant(
      campaignId: string,
      wallet: string,
      result: "accepted" | "rejected",
    ) {
      const participantKey = randomUUID().replace(/-/g, "").repeat(2);
      const { eligibility: record } =
        await eligibilityRepository.recordIdempotent({
          id: randomUUID(),
          campaignId,
          participantKey,
          claimantAddress: wallet,
          provider: "world_id",
          verifiedAt: new Date("2026-10-05T10:20:00.000Z"),
          expiresAt: new Date("2026-10-05T11:20:00.000Z"),
        });
      const submissionAnswers = [
        { questionId: "q1", normalizedAnswer: "a", score: "1" },
      ];
      const { submission } = await submissionRepository.recordIdempotent({
        id: randomUUID(),
        campaignId,
        eligibilityId: record.id,
        missionId: await missionIdFor(campaignId),
        idempotencyKey: randomUUID(),
        requestHash: hashSubmissionRequest({
          campaignId,
          claimantAddress: wallet,
          answers: submissionAnswers,
        }),
        claimantAddress: wallet,
        result,
        rejectionCode: result === "rejected" ? "BELOW_THRESHOLD" : null,
        answers: submissionAnswers,
        createdAt: new Date("2026-10-05T10:30:00.000Z"),
      });

      return {
        eligibilityId: record.id,
        submissionId: submission.id,
        participantKey,
      };
    }

    async function load(ids: { eligibilityId: string; submissionId: string }) {
      const [eligibilityRow] = await database.db
        .select()
        .from(eligibility)
        .where(eq(eligibility.id, ids.eligibilityId));
      const [submissionRow] = await database.db
        .select()
        .from(submissions)
        .where(eq(submissions.id, ids.submissionId));
      const answerRows = await database.db
        .select()
        .from(answers)
        .where(eq(answers.submissionId, ids.submissionId));

      return {
        participantKey: eligibilityRow!.participantKey,
        eligibilityWallet: eligibilityRow!.claimantAddress,
        submissionWallet: submissionRow!.claimantAddress,
        result: submissionRow!.result,
        answers: answerRows.length,
      };
    }

    it("erases one wallet only after claim issuance has settled", async () => {
      const campaignId = await createCampaign();
      const erased = `0x${"4".repeat(40)}`;
      const kept = `0x${"5".repeat(40)}`;
      const target = await participant(campaignId, erased, "rejected");
      const other = await participant(campaignId, kept, "rejected");

      // Before end + authorization TTL: nothing is touched yet.
      const early = await eraseWallet(
        database.db,
        erased,
        new Date("2026-10-05T11:20:00.000Z"),
      );
      expect(early.campaignsStillOpen).toBe(1);
      expect((await load(target)).answers).toBe(1);

      const result = await eraseWallet(
        database.db,
        erased,
        new Date("2026-10-05T12:00:00.000Z"),
      );
      expect(result).toMatchObject({
        answersDeleted: 1,
        participantKeysRetired: 1,
        walletLinksPseudonymized: 1,
        campaignsStillOpen: 0,
      });

      const after = await load(target);
      expect(after.answers).toBe(0);
      expect(after.participantKey).toMatch(HEX64);
      expect(after.participantKey).not.toBe(target.participantKey);
      expect(after.eligibilityWallet).toMatch(ADDRESS);
      expect(after.eligibilityWallet).not.toBe(erased);
      expect(after.submissionWallet).not.toBe(erased);

      // Other participants are untouched.
      expect(await load(other)).toMatchObject({
        participantKey: other.participantKey,
        eligibilityWallet: kept,
        answers: 1,
      });
    });

    it("applies the retention policy idempotently and keeps settlement facts", async () => {
      const campaignId = await createCampaign();
      const paidWallet = `0x${"6".repeat(40)}`;
      const unpaidWallet = `0x${"7".repeat(40)}`;
      const paid = await participant(campaignId, paidWallet, "accepted");
      const unpaid = await participant(campaignId, unpaidWallet, "rejected");

      // 25 days after the campaign ended: within every retention window.
      await applyRetention(database.db, new Date("2026-10-30T12:00:00.000Z"));
      expect(await load(unpaid)).toMatchObject({
        participantKey: unpaid.participantKey,
        eligibilityWallet: unpaidWallet,
        answers: 1,
      });

      const auth = new PostgresAuthRepository(database.db);
      await auth.createNonce(
        "old-nonce-123456",
        new Date("2026-10-01T00:00:00.000Z"),
        new Date("2026-10-01T00:10:00.000Z"),
      );
      await auth.createSession({
        sessionId: randomUUID(),
        tokenHash: "a".repeat(64),
        address: paidWallet,
        chainId: 84532,
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
        expiresAt: new Date("2026-10-01T12:00:00.000Z"),
      });

      const result = await applyRetention(
        database.db,
        new Date("2026-11-10T12:00:00.000Z"),
      );
      expect(result.answersDeleted).toBeGreaterThanOrEqual(2);
      expect(result.authNoncesDeleted).toBeGreaterThanOrEqual(1);
      expect(result.authSessionsDeleted).toBeGreaterThanOrEqual(1);

      // Paid participant: wallet and result stay (they match on-chain claims).
      const paidAfter = await load(paid);
      expect(paidAfter).toMatchObject({
        eligibilityWallet: paidWallet,
        submissionWallet: paidWallet,
        result: "accepted",
        answers: 0,
      });
      expect(paidAfter.participantKey).not.toBe(paid.participantKey);

      // Unpaid participant: no remaining link to the wallet or the human.
      const unpaidAfter = await load(unpaid);
      expect(unpaidAfter.result).toBe("rejected");
      expect(unpaidAfter.answers).toBe(0);
      expect(unpaidAfter.eligibilityWallet).toMatch(ADDRESS);
      expect(unpaidAfter.eligibilityWallet).not.toBe(unpaidWallet);
      expect(unpaidAfter.submissionWallet).toBe(unpaidAfter.eligibilityWallet);
      expect(unpaidAfter.participantKey).not.toBe(unpaid.participantKey);

      // Idempotent: a second run changes nothing.
      expect(
        await applyRetention(database.db, new Date("2026-11-10T12:00:00.000Z")),
      ).toEqual({
        answersDeleted: 0,
        participantKeysRetired: 0,
        walletLinksPseudonymized: 0,
        authNoncesDeleted: 0,
        authSessionsDeleted: 0,
      });
      expect(await load(unpaid)).toEqual(unpaidAfter);
    });
  });
});
