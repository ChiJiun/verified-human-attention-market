import { sql } from "drizzle-orm";

import type { MissionQuestion } from "../missions/types.js";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey(),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    onchainCampaignId: numeric("onchain_campaign_id", {
      precision: 78,
      scale: 0,
    }),
    publishTxHash: text("publish_tx_hash"),
    advertiserAddress: text("advertiser_address").notNull(),
    creationIdempotencyKey: text("creation_idempotency_key").notNull(),
    creationRequestHash: text("creation_request_hash").notNull(),
    contentUrl: text("content_url").notNull(),
    rewardAtomic: numeric("reward_atomic", {
      precision: 78,
      scale: 0,
    }).notNull(),
    maxCompletions: integer("max_completions").notNull(),
    startAt: timestamp("start_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    endAt: timestamp("end_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    index("campaigns_advertiser_idx").on(table.advertiserAddress),
    index("campaigns_status_idx").on(table.status),
    uniqueIndex("campaigns_advertiser_idempotency_uq").on(
      table.advertiserAddress,
      table.creationIdempotencyKey,
    ),
    // One database campaign per canonical on-chain campaign.
    uniqueIndex("campaigns_chain_onchain_id_uq").on(
      table.chainId,
      table.onchainCampaignId,
    ),
    check(
      "campaigns_status_check",
      sql`${table.status} IN ('draft', 'pending_onchain', 'active', 'closed', 'expired', 'settled', 'cancelled')`,
    ),
  ],
);

export const missions = pgTable(
  "missions",
  {
    id: uuid("id").primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    kind: text("kind").notNull().default("comprehension_check"),
    contentUrl: text("content_url").notNull(),
    questions: jsonb("questions").$type<MissionQuestion[]>().notNull(),
    // Server-only. Never serialize to participants.
    answerKey: jsonb("answer_key").$type<Record<string, string>>().notNull(),
    passThreshold: integer("pass_threshold").notNull(),
    definitionHash: text("definition_hash").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("missions_campaign_version_uq").on(
      table.campaignId,
      table.version,
    ),
    // Target of the composite FK that pins a submission to its campaign.
    uniqueIndex("missions_id_campaign_uq").on(table.id, table.campaignId),
    check("missions_version_positive", sql`${table.version} >= 1`),
    check("missions_pass_threshold_positive", sql`${table.passThreshold} >= 1`),
  ],
);

export const eligibility = pgTable(
  "eligibility",
  {
    id: uuid("id").primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "restrict" }),
    participantKey: text("participant_key").notNull(),
    claimantAddress: text("claimant_address").notNull(),
    provider: text("provider").notNull().default("world_id"),
    verifiedAt: timestamp("verified_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    // One verified human per campaign.
    uniqueIndex("eligibility_campaign_participant_uq").on(
      table.campaignId,
      table.participantKey,
    ),
    // One payout wallet per campaign; mirrors the contract's claimedWallet rule.
    uniqueIndex("eligibility_campaign_claimant_uq").on(
      table.campaignId,
      table.claimantAddress,
    ),
    // Only derived HMAC keys may be stored, never raw identity material.
    check(
      "eligibility_participant_key_format",
      sql`${table.participantKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "eligibility_claimant_address_format",
      sql`${table.claimantAddress} ~ '^0x[0-9a-f]{40}$'`,
    ),
  ],
);

export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "restrict" }),
    eligibilityId: uuid("eligibility_id")
      .notNull()
      .references(() => eligibility.id, { onDelete: "restrict" }),
    // Mission version used to evaluate this submission.
    missionId: uuid("mission_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    claimantAddress: text("claimant_address").notNull(),
    result: text("result").notNull(),
    rejectionCode: text("rejection_code"),
    claimNonce: text("claim_nonce"),
    claimIssuedAt: timestamp("claim_issued_at", {
      withTimezone: true,
      mode: "date",
    }),
    claimExpiresAt: timestamp("claim_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("submissions_campaign_idempotency_uq").on(
      table.campaignId,
      table.idempotencyKey,
    ),
    index("submissions_campaign_idx").on(table.campaignId),
    // At most one accepted completion (= one reward liability) per human.
    uniqueIndex("submissions_eligibility_accepted_uq")
      .on(table.eligibilityId)
      .where(sql`${table.result} = 'accepted'`),
    uniqueIndex("submissions_claim_nonce_uq").on(table.claimNonce),
    foreignKey({
      name: "submissions_mission_campaign_fk",
      columns: [table.missionId, table.campaignId],
      foreignColumns: [missions.id, missions.campaignId],
    }).onDelete("restrict"),
    check(
      "submissions_result_check",
      sql`(${table.result} = 'accepted' AND ${table.rejectionCode} IS NULL) OR (${table.result} = 'rejected' AND ${table.rejectionCode} IS NOT NULL)`,
    ),
    check(
      "submissions_claimant_address_format",
      sql`${table.claimantAddress} ~ '^0x[0-9a-f]{40}$'`,
    ),
  ],
);

export const answers = pgTable(
  "answers",
  {
    id: uuid("id").primaryKey(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    questionId: text("question_id").notNull(),
    normalizedAnswer: jsonb("normalized_answer").notNull(),
    score: numeric("score", { precision: 10, scale: 4 }),
  },
  (table) => [index("answers_submission_idx").on(table.submissionId)],
);

export const chainEvents = pgTable(
  "chain_events",
  {
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    contractAddress: text("contract_address").notNull(),
    // Decoded campaignId for campaign events; null for global events.
    onchainCampaignId: numeric("onchain_campaign_id", {
      precision: 78,
      scale: 0,
    }),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    blockHash: text("block_hash").notNull(),
    eventName: text("event_name").notNull(),
    payload: jsonb("payload").notNull(),
    confirmationStatus: text("confirmation_status")
      .notNull()
      .default("observed"),
    observedAt: timestamp("observed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("chain_events_identity_uq").on(
      table.chainId,
      table.txHash,
      table.logIndex,
    ),
    index("chain_events_block_idx").on(table.chainId, table.blockNumber),
    index("chain_events_campaign_idx").on(
      table.chainId,
      table.contractAddress,
      table.onchainCampaignId,
    ),
    check(
      "chain_events_confirmation_status_check",
      sql`${table.confirmationStatus} IN ('observed', 'confirmed', 'orphaned')`,
    ),
  ],
);

export const reconciliationState = pgTable(
  "reconciliation_state",
  {
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    contractAddress: text("contract_address").notNull(),
    latestObservedBlock: bigint("latest_observed_block", {
      mode: "number",
    }).notNull(),
    latestConfirmedBlock: bigint("latest_confirmed_block", {
      mode: "number",
    }).notNull(),
    // Detects reorgs deeper than the confirmation depth.
    latestConfirmedBlockHash: text("latest_confirmed_block_hash"),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.chainId, table.contractAddress] })],
);
