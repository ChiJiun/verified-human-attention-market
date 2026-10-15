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
    /**
     * CampaignManager the on-chain id belongs to. Ids restart at 1 on every
     * deployment, so a link is (chain, contract, id), never (chain, id).
     */
    onchainContractAddress: text("onchain_contract_address"),
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
    uniqueIndex("campaigns_chain_contract_onchain_id_uq").on(
      table.chainId,
      table.onchainContractAddress,
      table.onchainCampaignId,
    ),
    check(
      "campaigns_onchain_link_check",
      sql`(${table.onchainCampaignId} IS NULL) = (${table.onchainContractAddress} IS NULL)`,
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
    // Campaign-scoped quality reason codes (#25, ADR-0009).
    qualityFlags: jsonb("quality_flags")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    claimNonce: text("claim_nonce"),
    claimSignature: text("claim_signature"),
    claimContractAddress: text("claim_contract_address"),
    claimChainId: bigint("claim_chain_id", { mode: "number" }),
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

/** Single-use SIWE nonces (issue #37). */
export const authNonces = pgTable("auth_nonces", {
  nonce: text("nonce").primaryKey(),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  expiresAt: timestamp("expires_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
});

/** Wallet sessions. Only a sha256 of the bearer token is stored. */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    address: text("address").notNull(),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("auth_sessions_token_hash_uq").on(table.tokenHash),
    index("auth_sessions_address_idx").on(table.address),
  ],
);

/** Current moderation state per campaign (#24). No row = pending_review. */
export const campaignModeration = pgTable(
  "campaign_moderation",
  {
    campaignId: uuid("campaign_id")
      .primaryKey()
      .references(() => campaigns.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    index("campaign_moderation_status_idx").on(table.status),
    check(
      "campaign_moderation_status_check",
      sql`${table.status} IN ('pending_review', 'approved', 'rejected', 'taken_down')`,
    ),
  ],
);

/** Participant/public abuse reports. Reporter identity is not stored. */
export const campaignReports = pgTable(
  "campaign_reports",
  {
    id: uuid("id").primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    details: text("details"),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    resolvedBy: text("resolved_by"),
  },
  (table) => [
    index("campaign_reports_status_idx").on(table.status, table.createdAt),
    index("campaign_reports_campaign_idx").on(table.campaignId),
    check(
      "campaign_reports_reason_check",
      sql`${table.reason} IN ('phishing', 'malware', 'scam', 'misleading', 'offensive', 'broken_link', 'other')`,
    ),
    check(
      "campaign_reports_status_check",
      sql`${table.status} IN ('open', 'dismissed', 'actioned')`,
    ),
    check(
      "campaign_reports_details_length",
      sql`${table.details} IS NULL OR char_length(${table.details}) <= 500`,
    ),
  ],
);

/** Append-only operator audit trail (UPDATE/DELETE rejected by trigger). */
export const moderationActions = pgTable(
  "moderation_actions",
  {
    id: uuid("id").primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    actor: text("actor").notNull(),
    reason: text("reason").notNull(),
    reportId: uuid("report_id").references(() => campaignReports.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    index("moderation_actions_campaign_idx").on(
      table.campaignId,
      table.createdAt,
    ),
    check(
      "moderation_actions_action_check",
      sql`${table.action} IN ('approve', 'reject', 'take_down', 'reinstate', 'resolve_report')`,
    ),
    check(
      "moderation_actions_reason_length",
      sql`char_length(${table.reason}) BETWEEN 1 AND 1000`,
    ),
  ],
);

/**
 * External API clients (#26). A client acts as one advertiser wallet with
 * limited scopes. Only sha256(key) is stored; the key is shown once.
 */
export const apiClients = pgTable(
  "api_clients",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    advertiserAddress: text("advertiser_address").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    environment: text("environment").notNull(),
    rateLimitPerMinute: integer("rate_limit_per_minute").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    revokedBy: text("revoked_by"),
    revokedReason: text("revoked_reason"),
  },
  (table) => [
    uniqueIndex("api_clients_key_hash_uq").on(table.keyHash),
    index("api_clients_advertiser_idx").on(table.advertiserAddress),
    check(
      "api_clients_environment_check",
      sql`${table.environment} IN ('sandbox', 'live')`,
    ),
    check(
      "api_clients_advertiser_address_format",
      sql`${table.advertiserAddress} ~ '^0x[0-9a-f]{40}$'`,
    ),
    check(
      "api_clients_rate_limit_positive",
      sql`${table.rateLimitPerMinute} > 0`,
    ),
  ],
);
