import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
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
  ],
);

export const eligibility = pgTable(
  "eligibility",
  {
    id: uuid("id").primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
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
    uniqueIndex("eligibility_campaign_participant_uq").on(
      table.campaignId,
      table.participantKey,
    ),
  ],
);

export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    eligibilityId: uuid("eligibility_id")
      .notNull()
      .references(() => eligibility.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
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
  ],
);

export const reconciliationState = pgTable("reconciliation_state", {
  chainId: bigint("chain_id", { mode: "number" }).primaryKey(),
  latestObservedBlock: bigint("latest_observed_block", {
    mode: "number",
  }).notNull(),
  latestConfirmedBlock: bigint("latest_confirmed_block", {
    mode: "number",
  }).notNull(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
});
