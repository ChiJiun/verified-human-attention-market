import { randomUUID } from "node:crypto";

import { and, asc, desc, eq } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  campaignModeration,
  campaignReports,
  moderationActions,
} from "../db/schema.js";

/**
 * Campaign moderation (#24). Moderation state lives beside, never inside,
 * settlement data: actions change only whether the API serves a campaign
 * to new participants. Every change is appended to an immutable audit log.
 */

export type ModerationStatus =
  "pending_review" | "approved" | "rejected" | "taken_down";

export type ModerationActionKind =
  "approve" | "reject" | "take_down" | "reinstate" | "resolve_report";

export type StatusAction = Exclude<ModerationActionKind, "resolve_report">;

export const REPORT_REASONS = [
  "phishing",
  "malware",
  "scam",
  "misleading",
  "offensive",
  "broken_link",
  "other",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];
export type ReportStatus = "open" | "dismissed" | "actioned";

/** Allowed status transitions. Anything else is INVALID_TRANSITION. */
export const TRANSITIONS: Record<
  StatusAction,
  { from: readonly ModerationStatus[]; to: ModerationStatus }
> = {
  approve: { from: ["pending_review", "rejected"], to: "approved" },
  reject: { from: ["pending_review"], to: "rejected" },
  take_down: { from: ["pending_review", "approved"], to: "taken_down" },
  reinstate: { from: ["taken_down"], to: "approved" },
};

export interface ModerationState {
  campaignId: string;
  status: ModerationStatus;
  updatedAt: Date;
}

export interface ModerationActionRecord {
  id: string;
  campaignId: string;
  action: ModerationActionKind;
  fromStatus: ModerationStatus | null;
  toStatus: ModerationStatus | null;
  actor: string;
  reason: string;
  reportId: string | null;
  createdAt: Date;
}

export interface ReportRecord {
  id: string;
  campaignId: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}

export type ModerationErrorCode =
  | "INVALID_TRANSITION"
  | "REPORT_NOT_FOUND"
  | "REPORT_ALREADY_RESOLVED"
  | "REPORT_CAMPAIGN_MISMATCH";

export class ModerationError extends Error {
  constructor(readonly code: ModerationErrorCode) {
    super(code);
    this.name = "ModerationError";
  }
}

export interface ApplyActionInput {
  campaignId: string;
  action: StatusAction;
  actor: string;
  reason: string;
  /** Report that prompted the action, if any (it is not resolved here). */
  reportId: string | null;
  at: Date;
}

export interface ResolveReportInput {
  reportId: string;
  resolution: "dismissed" | "actioned";
  actor: string;
  reason: string;
  at: Date;
}

export interface ModerationRepository {
  /**
   * Creates the state row if missing (idempotent). An "approved" initial
   * state (allowlist, open mode) is recorded in the audit log.
   */
  initialize(
    campaignId: string,
    initial: "pending_review" | "approved",
    actor: string,
    reason: string,
    at: Date,
  ): Promise<ModerationState>;
  getState(campaignId: string): Promise<ModerationState | null>;
  applyAction(input: ApplyActionInput): Promise<ModerationState>;
  listByStatus(
    status: ModerationStatus,
    limit: number,
  ): Promise<ModerationState[]>;
  listActions(campaignId: string): Promise<ModerationActionRecord[]>;
  createReport(input: {
    campaignId: string;
    reason: ReportReason;
    details: string | null;
    at: Date;
  }): Promise<ReportRecord>;
  listReports(
    filter: { status?: ReportStatus; campaignId?: string },
    limit: number,
  ): Promise<ReportRecord[]>;
  resolveReport(input: ResolveReportInput): Promise<ReportRecord>;
}

function transition(
  from: ModerationStatus,
  action: StatusAction,
): ModerationStatus {
  const rule = TRANSITIONS[action];

  if (!rule.from.includes(from)) {
    throw new ModerationError("INVALID_TRANSITION");
  }

  return rule.to;
}

export class InMemoryModerationRepository implements ModerationRepository {
  private readonly states = new Map<string, ModerationState>();
  private readonly actions: ModerationActionRecord[] = [];
  private readonly reports = new Map<string, ReportRecord>();

  async initialize(
    campaignId: string,
    initial: "pending_review" | "approved",
    actor: string,
    reason: string,
    at: Date,
  ): Promise<ModerationState> {
    const existing = this.states.get(campaignId);

    if (existing) {
      return { ...existing };
    }

    const state = { campaignId, status: initial, updatedAt: at };
    this.states.set(campaignId, state);

    if (initial === "approved") {
      this.actions.push({
        id: randomUUID(),
        campaignId,
        action: "approve",
        fromStatus: null,
        toStatus: "approved",
        actor,
        reason,
        reportId: null,
        createdAt: at,
      });
    }

    return { ...state };
  }

  async getState(campaignId: string): Promise<ModerationState | null> {
    const state = this.states.get(campaignId);
    return state ? { ...state } : null;
  }

  async applyAction(input: ApplyActionInput): Promise<ModerationState> {
    if (input.reportId !== null) {
      this.reportFor(input.reportId, input.campaignId);
    }

    const from = this.states.get(input.campaignId)?.status ?? "pending_review";
    const to = transition(from, input.action);
    const state = {
      campaignId: input.campaignId,
      status: to,
      updatedAt: input.at,
    };

    this.states.set(input.campaignId, state);
    this.actions.push({
      id: randomUUID(),
      campaignId: input.campaignId,
      action: input.action,
      fromStatus: from,
      toStatus: to,
      actor: input.actor,
      reason: input.reason,
      reportId: input.reportId,
      createdAt: input.at,
    });

    return { ...state };
  }

  async listByStatus(
    status: ModerationStatus,
    limit: number,
  ): Promise<ModerationState[]> {
    return [...this.states.values()]
      .filter((state) => state.status === status)
      .sort(
        (left, right) => left.updatedAt.getTime() - right.updatedAt.getTime(),
      )
      .slice(0, limit)
      .map((state) => ({ ...state }));
  }

  async listActions(campaignId: string): Promise<ModerationActionRecord[]> {
    return this.actions
      .filter((action) => action.campaignId === campaignId)
      .map((action) => ({ ...action }));
  }

  async createReport(input: {
    campaignId: string;
    reason: ReportReason;
    details: string | null;
    at: Date;
  }): Promise<ReportRecord> {
    const report: ReportRecord = {
      id: randomUUID(),
      campaignId: input.campaignId,
      reason: input.reason,
      details: input.details,
      status: "open",
      createdAt: input.at,
      resolvedAt: null,
      resolvedBy: null,
    };
    this.reports.set(report.id, report);
    return { ...report };
  }

  async listReports(
    filter: { status?: ReportStatus; campaignId?: string },
    limit: number,
  ): Promise<ReportRecord[]> {
    return [...this.reports.values()]
      .filter(
        (report) =>
          (filter.status === undefined || report.status === filter.status) &&
          (filter.campaignId === undefined ||
            report.campaignId === filter.campaignId),
      )
      .slice(0, limit)
      .map((report) => ({ ...report }));
  }

  async resolveReport(input: ResolveReportInput): Promise<ReportRecord> {
    const report = this.reports.get(input.reportId);

    if (!report) {
      throw new ModerationError("REPORT_NOT_FOUND");
    }

    if (report.status !== "open") {
      throw new ModerationError("REPORT_ALREADY_RESOLVED");
    }

    const resolved: ReportRecord = {
      ...report,
      status: input.resolution,
      resolvedAt: input.at,
      resolvedBy: input.actor,
    };
    this.reports.set(report.id, resolved);
    this.actions.push({
      id: randomUUID(),
      campaignId: report.campaignId,
      action: "resolve_report",
      fromStatus: null,
      toStatus: null,
      actor: input.actor,
      reason: `${input.resolution}: ${input.reason}`,
      reportId: report.id,
      createdAt: input.at,
    });

    return { ...resolved };
  }

  private reportFor(reportId: string, campaignId: string): ReportRecord {
    const report = this.reports.get(reportId);

    if (!report) {
      throw new ModerationError("REPORT_NOT_FOUND");
    }

    if (report.campaignId !== campaignId) {
      throw new ModerationError("REPORT_CAMPAIGN_MISMATCH");
    }

    return report;
  }
}

type ModerationRow = typeof campaignModeration.$inferSelect;
type ActionRow = typeof moderationActions.$inferSelect;
type ReportRow = typeof campaignReports.$inferSelect;

const toState = (row: ModerationRow): ModerationState => ({
  campaignId: row.campaignId,
  status: row.status as ModerationStatus,
  updatedAt: row.updatedAt,
});

const toAction = (row: ActionRow): ModerationActionRecord => ({
  id: row.id,
  campaignId: row.campaignId,
  action: row.action as ModerationActionKind,
  fromStatus: row.fromStatus as ModerationStatus | null,
  toStatus: row.toStatus as ModerationStatus | null,
  actor: row.actor,
  reason: row.reason,
  reportId: row.reportId,
  createdAt: row.createdAt,
});

const toReport = (row: ReportRow): ReportRecord => ({
  id: row.id,
  campaignId: row.campaignId,
  reason: row.reason as ReportReason,
  details: row.details,
  status: row.status as ReportStatus,
  createdAt: row.createdAt,
  resolvedAt: row.resolvedAt,
  resolvedBy: row.resolvedBy,
});

export class PostgresModerationRepository implements ModerationRepository {
  constructor(private readonly db: Database) {}

  async initialize(
    campaignId: string,
    initial: "pending_review" | "approved",
    actor: string,
    reason: string,
    at: Date,
  ): Promise<ModerationState> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(campaignModeration)
        .values({ campaignId, status: initial, updatedAt: at })
        .onConflictDoNothing()
        .returning();

      if (inserted[0] && initial === "approved") {
        await tx.insert(moderationActions).values({
          id: randomUUID(),
          campaignId,
          action: "approve",
          fromStatus: null,
          toStatus: "approved",
          actor,
          reason,
          reportId: null,
          createdAt: at,
        });
      }

      if (inserted[0]) {
        return toState(inserted[0]);
      }

      const [existing] = await tx
        .select()
        .from(campaignModeration)
        .where(eq(campaignModeration.campaignId, campaignId));
      return toState(existing!);
    });
  }

  async getState(campaignId: string): Promise<ModerationState | null> {
    const [row] = await this.db
      .select()
      .from(campaignModeration)
      .where(eq(campaignModeration.campaignId, campaignId))
      .limit(1);
    return row ? toState(row) : null;
  }

  async applyAction(input: ApplyActionInput): Promise<ModerationState> {
    return this.db.transaction(async (tx) => {
      if (input.reportId !== null) {
        const [report] = await tx
          .select()
          .from(campaignReports)
          .where(eq(campaignReports.id, input.reportId));

        if (!report) {
          throw new ModerationError("REPORT_NOT_FOUND");
        }

        if (report.campaignId !== input.campaignId) {
          throw new ModerationError("REPORT_CAMPAIGN_MISMATCH");
        }
      }

      // Row lock: concurrent operator actions apply one after the other.
      await tx
        .insert(campaignModeration)
        .values({
          campaignId: input.campaignId,
          status: "pending_review",
          updatedAt: input.at,
        })
        .onConflictDoNothing();
      const [current] = await tx
        .select()
        .from(campaignModeration)
        .where(eq(campaignModeration.campaignId, input.campaignId))
        .for("update");

      const from = current!.status as ModerationStatus;
      const to = transition(from, input.action);

      const [updated] = await tx
        .update(campaignModeration)
        .set({ status: to, updatedAt: input.at })
        .where(eq(campaignModeration.campaignId, input.campaignId))
        .returning();
      await tx.insert(moderationActions).values({
        id: randomUUID(),
        campaignId: input.campaignId,
        action: input.action,
        fromStatus: from,
        toStatus: to,
        actor: input.actor,
        reason: input.reason,
        reportId: input.reportId,
        createdAt: input.at,
      });

      return toState(updated!);
    });
  }

  async listByStatus(
    status: ModerationStatus,
    limit: number,
  ): Promise<ModerationState[]> {
    const rows = await this.db
      .select()
      .from(campaignModeration)
      .where(eq(campaignModeration.status, status))
      .orderBy(asc(campaignModeration.updatedAt))
      .limit(limit);
    return rows.map(toState);
  }

  async listActions(campaignId: string): Promise<ModerationActionRecord[]> {
    const rows = await this.db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.campaignId, campaignId))
      .orderBy(asc(moderationActions.createdAt));
    return rows.map(toAction);
  }

  async createReport(input: {
    campaignId: string;
    reason: ReportReason;
    details: string | null;
    at: Date;
  }): Promise<ReportRecord> {
    const [row] = await this.db
      .insert(campaignReports)
      .values({
        id: randomUUID(),
        campaignId: input.campaignId,
        reason: input.reason,
        details: input.details,
        status: "open",
        createdAt: input.at,
      })
      .returning();
    return toReport(row!);
  }

  async listReports(
    filter: { status?: ReportStatus; campaignId?: string },
    limit: number,
  ): Promise<ReportRecord[]> {
    const conditions = [
      filter.status ? eq(campaignReports.status, filter.status) : undefined,
      filter.campaignId
        ? eq(campaignReports.campaignId, filter.campaignId)
        : undefined,
    ].filter((condition) => condition !== undefined);

    const rows = await this.db
      .select()
      .from(campaignReports)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(campaignReports.createdAt))
      .limit(limit);
    return rows.map(toReport);
  }

  async resolveReport(input: ResolveReportInput): Promise<ReportRecord> {
    return this.db.transaction(async (tx) => {
      const [report] = await tx
        .select()
        .from(campaignReports)
        .where(eq(campaignReports.id, input.reportId))
        .for("update");

      if (!report) {
        throw new ModerationError("REPORT_NOT_FOUND");
      }

      if (report.status !== "open") {
        throw new ModerationError("REPORT_ALREADY_RESOLVED");
      }

      const [resolved] = await tx
        .update(campaignReports)
        .set({
          status: input.resolution,
          resolvedAt: input.at,
          resolvedBy: input.actor,
        })
        .where(eq(campaignReports.id, input.reportId))
        .returning();
      await tx.insert(moderationActions).values({
        id: randomUUID(),
        campaignId: report.campaignId,
        action: "resolve_report",
        fromStatus: null,
        toStatus: null,
        actor: input.actor,
        reason: `${input.resolution}: ${input.reason}`,
        reportId: report.id,
        createdAt: input.at,
      });

      return toReport(resolved!);
    });
  }
}
