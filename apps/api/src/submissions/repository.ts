import { createHash, randomUUID } from "node:crypto";

import { and, asc, count, eq, gte } from "drizzle-orm";

import type { Database, PersistenceScope } from "../db/client.js";
import { answers, eligibility, submissions } from "../db/schema.js";
import type {
  EligibilityRecord,
  EligibilityRepository,
} from "../eligibility/repository.js";
import {
  IdempotencyConflictError,
  uniqueViolationConstraint,
} from "../persistence/errors.js";

export type SubmissionResult = "accepted" | "rejected";

export interface AnswerInput {
  questionId: string;
  /** Normalized, minimal answer (e.g. a choice id). No free text in the POC. */
  normalizedAnswer: unknown;
  /** Decimal string, or null when not scored. */
  score: string | null;
}

export interface AnswerRecord extends AnswerInput {
  id: string;
}

export interface NewSubmission {
  id: string;
  campaignId: string;
  eligibilityId: string;
  /** Mission version the submission was evaluated against. */
  missionId: string;
  idempotencyKey: string;
  /** Hash of the normalized request, see `hashSubmissionRequest`. */
  requestHash: string;
  claimantAddress: string;
  result: SubmissionResult;
  /** Required when rejected, must be null when accepted. */
  rejectionCode: string | null;
  answers: AnswerInput[];
  /** Quality reason codes (#25); empty when none. */
  qualityFlags?: string[];
  createdAt: Date;
  /**
   * Runs after the submission and its answers are stored and before they are
   * committed, inside the same transaction; if it throws, nothing is
   * persisted. Used to sign the claim authorization together with an
   * acceptance so that no accepted completion exists without one (ADR-0011).
   */
  beforeCommit?: (
    submission: SubmissionRecord,
    scope: PersistenceScope,
  ) => Promise<void>;
}

export interface QualitySummary {
  /** Accepted submissions carrying at least one quality flag. */
  flaggedAccepted: number;
  /** Count per reason code across accepted submissions. */
  reasons: Record<string, number>;
}

export interface SubmissionRecord {
  id: string;
  campaignId: string;
  eligibilityId: string;
  missionId: string;
  idempotencyKey: string;
  requestHash: string;
  claimantAddress: string;
  result: SubmissionResult;
  rejectionCode: string | null;
  qualityFlags: string[];
  claimNonce: string | null;
  claimIssuedAt: Date | null;
  claimExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  answers: AnswerRecord[];
}

export interface IdempotentSubmissionResult {
  submission: SubmissionRecord;
  created: boolean;
}

/** The human already has an accepted completion (reward liability) here. */
export class DuplicateCompletionError extends Error {
  constructor(readonly existingSubmissionId: string | null) {
    super("An accepted completion already exists for this participant");
    this.name = "DuplicateCompletionError";
  }
}

export type SubmissionEligibilityErrorCode =
  | "ELIGIBILITY_NOT_FOUND"
  | "ELIGIBILITY_CAMPAIGN_MISMATCH"
  | "ELIGIBILITY_CLAIMANT_MISMATCH"
  | "ELIGIBILITY_EXPIRED";

export class SubmissionEligibilityError extends Error {
  constructor(readonly code: SubmissionEligibilityErrorCode) {
    super(`Submission eligibility check failed: ${code}`);
    this.name = "SubmissionEligibilityError";
  }
}

export interface SubmissionRepository {
  /**
   * Persists a verified submission and its answers atomically.
   *
   * - Same idempotency key + same request hash returns the original result.
   * - Same idempotency key + different request hash throws
   *   IdempotencyConflictError.
   * - A second *accepted* submission for the same eligibility throws
   *   DuplicateCompletionError, so retries cannot create a second reward
   *   liability. Rejected submissions may be retried with a new key.
   */
  recordIdempotent(input: NewSubmission): Promise<IdempotentSubmissionResult>;
  getById(id: string): Promise<SubmissionRecord | null>;
  findAcceptedByEligibility(
    eligibilityId: string,
  ): Promise<SubmissionRecord | null>;
  findByIdempotencyKey(
    campaignId: string,
    idempotencyKey: string,
  ): Promise<SubmissionRecord | null>;
  /** Number of persisted attempts (accepted + rejected) for an eligibility. */
  countByEligibility(eligibilityId: string): Promise<number>;
  countByCampaign(
    campaignId: string,
  ): Promise<{ accepted: number; rejected: number }>;
  /** Submissions (any result) created at or after `since`. */
  countRecentByCampaign(campaignId: string, since: Date): Promise<number>;
  qualitySummary(campaignId: string): Promise<QualitySummary>;
}

function summarize(
  rows: { result: string; qualityFlags: string[] }[],
): QualitySummary {
  const summary: QualitySummary = { flaggedAccepted: 0, reasons: {} };

  for (const row of rows) {
    if (row.result !== "accepted" || row.qualityFlags.length === 0) continue;
    summary.flaggedAccepted += 1;
    for (const flag of row.qualityFlags) {
      summary.reasons[flag] = (summary.reasons[flag] ?? 0) + 1;
    }
  }

  return summary;
}

/**
 * Canonical request hash for submission idempotency. Answers are sorted so
 * that ordering differences do not count as a different request.
 */
export function hashSubmissionRequest(request: {
  campaignId: string;
  claimantAddress: string;
  answers: { questionId: string; normalizedAnswer: unknown }[];
}): string {
  const canonical = JSON.stringify({
    campaignId: request.campaignId,
    claimantAddress: request.claimantAddress.toLowerCase(),
    answers: [...request.answers]
      .sort((left, right) => left.questionId.localeCompare(right.questionId))
      .map((answer) => [answer.questionId, answer.normalizedAnswer]),
  });

  return createHash("sha256").update(canonical).digest("hex");
}

function normalize(input: NewSubmission): NewSubmission {
  if (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 200) {
    throw new Error("idempotencyKey must be 1-200 characters");
  }

  if (input.result === "accepted" && input.rejectionCode !== null) {
    throw new Error("Accepted submissions cannot have a rejection code");
  }

  if (input.result === "rejected" && !input.rejectionCode) {
    throw new Error("Rejected submissions require a rejection code");
  }

  return { ...input, claimantAddress: input.claimantAddress.toLowerCase() };
}

function assertEligible(
  input: NewSubmission,
  record: EligibilityRecord | null,
): void {
  if (!record) {
    throw new SubmissionEligibilityError("ELIGIBILITY_NOT_FOUND");
  }

  if (record.campaignId !== input.campaignId) {
    throw new SubmissionEligibilityError("ELIGIBILITY_CAMPAIGN_MISMATCH");
  }

  if (record.claimantAddress !== input.claimantAddress) {
    throw new SubmissionEligibilityError("ELIGIBILITY_CLAIMANT_MISMATCH");
  }

  if (record.expiresAt <= input.createdAt) {
    throw new SubmissionEligibilityError("ELIGIBILITY_EXPIRED");
  }
}

function replay(
  input: NewSubmission,
  existing: SubmissionRecord,
): IdempotentSubmissionResult {
  if (existing.requestHash !== input.requestHash) {
    throw new IdempotencyConflictError();
  }

  return { submission: existing, created: false };
}

type SubmissionRow = typeof submissions.$inferSelect;
type AnswerRow = typeof answers.$inferSelect;

function mapSubmission(
  row: SubmissionRow,
  answerRows: AnswerRow[],
): SubmissionRecord {
  return {
    id: row.id,
    campaignId: row.campaignId,
    eligibilityId: row.eligibilityId,
    missionId: row.missionId,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    claimantAddress: row.claimantAddress,
    result: row.result as SubmissionResult,
    rejectionCode: row.rejectionCode,
    qualityFlags: row.qualityFlags,
    claimNonce: row.claimNonce,
    claimIssuedAt: row.claimIssuedAt,
    claimExpiresAt: row.claimExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    answers: answerRows.map((answer) => ({
      id: answer.id,
      questionId: answer.questionId,
      normalizedAnswer: answer.normalizedAnswer,
      score: answer.score,
    })),
  };
}

const ACCEPTED_PER_ELIGIBILITY = "submissions_eligibility_accepted_uq";

export class PostgresSubmissionRepository implements SubmissionRepository {
  constructor(private readonly db: Database) {}

  async recordIdempotent(
    rawInput: NewSubmission,
  ): Promise<IdempotentSubmissionResult> {
    const input = normalize(rawInput);

    const existing = await this.findByIdempotencyKey(
      input.campaignId,
      input.idempotencyKey,
    );

    if (existing) {
      return replay(input, existing);
    }

    const [eligibilityRow] = await this.db
      .select()
      .from(eligibility)
      .where(eq(eligibility.id, input.eligibilityId))
      .limit(1);

    assertEligible(input, eligibilityRow ?? null);

    let inserted: SubmissionRecord | null;

    try {
      inserted = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(submissions)
          .values({
            id: input.id,
            campaignId: input.campaignId,
            eligibilityId: input.eligibilityId,
            missionId: input.missionId,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            claimantAddress: input.claimantAddress,
            result: input.result,
            rejectionCode: input.rejectionCode,
            qualityFlags: input.qualityFlags ?? [],
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          })
          .onConflictDoNothing({
            target: [submissions.campaignId, submissions.idempotencyKey],
          })
          .returning();

        if (!row) {
          // A concurrent request with the same idempotency key won the race.
          return null;
        }

        const answerRows =
          input.answers.length === 0
            ? []
            : await tx
                .insert(answers)
                .values(
                  input.answers.map((answer) => ({
                    id: randomUUID(),
                    submissionId: row.id,
                    questionId: answer.questionId,
                    normalizedAnswer: answer.normalizedAnswer,
                    score: answer.score,
                  })),
                )
                .returning();

        const record = mapSubmission(row, answerRows);
        if (input.beforeCommit) {
          // Throwing here rolls the whole insert back.
          await input.beforeCommit(record, tx);
        }
        return record;
      });
    } catch (error) {
      if (uniqueViolationConstraint(error) === ACCEPTED_PER_ELIGIBILITY) {
        // A concurrent retry of this same request may have committed first.
        const sameKey = await this.findByIdempotencyKey(
          input.campaignId,
          input.idempotencyKey,
        );

        if (sameKey) {
          return replay(input, sameKey);
        }

        const accepted = await this.findAcceptedByEligibility(
          input.eligibilityId,
        );
        throw new DuplicateCompletionError(accepted?.id ?? null);
      }

      throw error;
    }

    if (inserted) {
      return { submission: inserted, created: true };
    }

    const raced = await this.findByIdempotencyKey(
      input.campaignId,
      input.idempotencyKey,
    );

    if (!raced) {
      throw new Error("Idempotent submission insert could not be reconciled");
    }

    return replay(input, raced);
  }

  async getById(id: string): Promise<SubmissionRecord | null> {
    const [row] = await this.db
      .select()
      .from(submissions)
      .where(eq(submissions.id, id))
      .limit(1);

    return row ? this.withAnswers(row) : null;
  }

  async findAcceptedByEligibility(
    eligibilityId: string,
  ): Promise<SubmissionRecord | null> {
    const [row] = await this.db
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.eligibilityId, eligibilityId),
          eq(submissions.result, "accepted"),
        ),
      )
      .limit(1);

    return row ? this.withAnswers(row) : null;
  }

  async countByCampaign(
    campaignId: string,
  ): Promise<{ accepted: number; rejected: number }> {
    const rows = await this.db
      .select({ result: submissions.result, value: count() })
      .from(submissions)
      .where(eq(submissions.campaignId, campaignId))
      .groupBy(submissions.result);

    const totals = { accepted: 0, rejected: 0 };
    for (const row of rows) {
      if (row.result === "accepted" || row.result === "rejected") {
        totals[row.result] = row.value;
      }
    }

    return totals;
  }

  async countRecentByCampaign(
    campaignId: string,
    since: Date,
  ): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(submissions)
      .where(
        and(
          eq(submissions.campaignId, campaignId),
          gte(submissions.createdAt, since),
        ),
      );
    return row?.value ?? 0;
  }

  async qualitySummary(campaignId: string): Promise<QualitySummary> {
    const rows = await this.db
      .select({
        result: submissions.result,
        qualityFlags: submissions.qualityFlags,
      })
      .from(submissions)
      .where(
        and(
          eq(submissions.campaignId, campaignId),
          eq(submissions.result, "accepted"),
        ),
      );
    return summarize(rows);
  }

  async countByEligibility(eligibilityId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(submissions)
      .where(eq(submissions.eligibilityId, eligibilityId));

    return row?.value ?? 0;
  }

  async findByIdempotencyKey(
    campaignId: string,
    idempotencyKey: string,
  ): Promise<SubmissionRecord | null> {
    const [row] = await this.db
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.campaignId, campaignId),
          eq(submissions.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    return row ? this.withAnswers(row) : null;
  }

  private async withAnswers(row: SubmissionRow): Promise<SubmissionRecord> {
    const answerRows = await this.db
      .select()
      .from(answers)
      .where(eq(answers.submissionId, row.id))
      .orderBy(asc(answers.questionId));

    return mapSubmission(row, answerRows);
  }
}

export class InMemorySubmissionRepository implements SubmissionRepository {
  private readonly records = new Map<string, SubmissionRecord>();

  constructor(private readonly eligibilityRepository: EligibilityRepository) {}

  async recordIdempotent(
    rawInput: NewSubmission,
  ): Promise<IdempotentSubmissionResult> {
    const input = normalize(rawInput);
    const existing = this.findByKeySync(input.campaignId, input.idempotencyKey);

    if (existing) {
      return replay(input, existing);
    }

    assertEligible(
      input,
      await this.eligibilityRepository.getById(input.eligibilityId),
    );

    // Re-check after the await: another call may have interleaved.
    const raced = this.findByKeySync(input.campaignId, input.idempotencyKey);

    if (raced) {
      return replay(input, raced);
    }

    if (input.result === "accepted") {
      const accepted = this.findAccepted(input.eligibilityId);

      if (accepted) {
        throw new DuplicateCompletionError(accepted.id);
      }
    }

    const record: SubmissionRecord = {
      id: input.id,
      campaignId: input.campaignId,
      eligibilityId: input.eligibilityId,
      missionId: input.missionId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      claimantAddress: input.claimantAddress,
      result: input.result,
      rejectionCode: input.rejectionCode,
      qualityFlags: [...(input.qualityFlags ?? [])],
      claimNonce: null,
      claimIssuedAt: null,
      claimExpiresAt: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      answers: [...input.answers]
        .sort((left, right) => left.questionId.localeCompare(right.questionId))
        .map((answer) => ({ ...answer, id: randomUUID() })),
    };

    this.records.set(record.id, record);

    if (input.beforeCommit) {
      try {
        await input.beforeCommit(record, null);
      } catch (error) {
        // Same as a rolled-back transaction: nothing was persisted.
        this.records.delete(record.id);
        throw error;
      }
    }

    return { submission: record, created: true };
  }

  async getById(id: string): Promise<SubmissionRecord | null> {
    return this.records.get(id) ?? null;
  }

  async findAcceptedByEligibility(
    eligibilityId: string,
  ): Promise<SubmissionRecord | null> {
    return this.findAccepted(eligibilityId);
  }

  private findAccepted(eligibilityId: string): SubmissionRecord | null {
    for (const record of this.records.values()) {
      if (
        record.eligibilityId === eligibilityId &&
        record.result === "accepted"
      ) {
        return record;
      }
    }

    return null;
  }

  async findByIdempotencyKey(
    campaignId: string,
    idempotencyKey: string,
  ): Promise<SubmissionRecord | null> {
    return this.findByKeySync(campaignId, idempotencyKey);
  }

  async countByCampaign(
    campaignId: string,
  ): Promise<{ accepted: number; rejected: number }> {
    const totals = { accepted: 0, rejected: 0 };

    for (const record of this.records.values()) {
      if (record.campaignId === campaignId) {
        totals[record.result] += 1;
      }
    }

    return totals;
  }

  async countRecentByCampaign(
    campaignId: string,
    since: Date,
  ): Promise<number> {
    return [...this.records.values()].filter(
      (record) => record.campaignId === campaignId && record.createdAt >= since,
    ).length;
  }

  async qualitySummary(campaignId: string): Promise<QualitySummary> {
    return summarize(
      [...this.records.values()].filter(
        (record) => record.campaignId === campaignId,
      ),
    );
  }

  async countByEligibility(eligibilityId: string): Promise<number> {
    let total = 0;

    for (const record of this.records.values()) {
      if (record.eligibilityId === eligibilityId) {
        total += 1;
      }
    }

    return total;
  }

  private findByKeySync(
    campaignId: string,
    idempotencyKey: string,
  ): SubmissionRecord | null {
    for (const record of this.records.values()) {
      if (
        record.campaignId === campaignId &&
        record.idempotencyKey === idempotencyKey
      ) {
        return record;
      }
    }

    return null;
  }
}
