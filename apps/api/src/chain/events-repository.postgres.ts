import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { chainEvents, reconciliationState } from "../db/schema.js";
import type { CampaignManagerEvent } from "./abi.js";
import {
  byChainOrder,
  campaignIdOf,
  identity,
  type ChainEventRepository,
  type ChainScope,
  type ConfirmationStatus,
  type IndexedEvent,
  type IndexerCursor,
  type StoredEvent,
} from "./events-repository.js";

export class PostgresChainEventRepository implements ChainEventRepository {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getCursor(scope: ChainScope): Promise<IndexerCursor | null> {
    const [row] = await this.db
      .select()
      .from(reconciliationState)
      .where(
        and(
          eq(reconciliationState.chainId, scope.chainId),
          eq(reconciliationState.contractAddress, scope.contractAddress),
        ),
      )
      .limit(1);

    return row
      ? {
          latestConfirmedBlock: BigInt(row.latestConfirmedBlock),
          latestConfirmedBlockHash: row.latestConfirmedBlockHash,
          latestObservedBlock: BigInt(row.latestObservedBlock),
        }
      : null;
  }

  private rows(
    scope: ChainScope,
    events: IndexedEvent[],
    status: ConfirmationStatus,
  ) {
    const observedAt = this.now();

    return events.map((event) => ({
      chainId: scope.chainId,
      contractAddress: scope.contractAddress,
      onchainCampaignId: campaignIdOf(event.event),
      txHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: Number(event.blockNumber),
      blockHash: event.blockHash,
      eventName: event.event.name,
      payload: event.event,
      confirmationStatus: status,
      observedAt,
    }));
  }

  async commitConfirmedRange(
    scope: ChainScope,
    range: { from: bigint; to: bigint; toBlockHash: string },
    events: IndexedEvent[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (events.length > 0) {
        await tx
          .insert(chainEvents)
          .values(this.rows(scope, events, "confirmed"))
          .onConflictDoUpdate({
            target: [
              chainEvents.chainId,
              chainEvents.txHash,
              chainEvents.logIndex,
            ],
            set: {
              blockNumber: sql`excluded.block_number`,
              blockHash: sql`excluded.block_hash`,
              payload: sql`excluded.payload`,
              eventName: sql`excluded.event_name`,
              onchainCampaignId: sql`excluded.onchain_campaign_id`,
              confirmationStatus: "confirmed",
            },
          });
      }

      const canonical = new Set(events.map(identity));
      const stale = await tx
        .select({
          txHash: chainEvents.txHash,
          logIndex: chainEvents.logIndex,
        })
        .from(chainEvents)
        .where(
          and(
            eq(chainEvents.chainId, scope.chainId),
            eq(chainEvents.contractAddress, scope.contractAddress),
            eq(chainEvents.confirmationStatus, "observed"),
            gte(chainEvents.blockNumber, Number(range.from)),
            lte(chainEvents.blockNumber, Number(range.to)),
          ),
        );

      await this.orphan(
        tx,
        scope,
        stale.filter((row) => !canonical.has(identity(row))),
      );

      await this.upsertCursor(tx, scope, {
        latestConfirmedBlock: range.to,
        latestConfirmedBlockHash: range.toBlockHash,
        latestObservedBlock: range.to,
      });
    });
  }

  async replaceObservedTail(
    scope: ChainScope,
    range: { from: bigint; to: bigint },
    events: IndexedEvent[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const current = new Set(events.map(identity));
      const previous = await tx
        .select({
          txHash: chainEvents.txHash,
          logIndex: chainEvents.logIndex,
        })
        .from(chainEvents)
        .where(
          and(
            eq(chainEvents.chainId, scope.chainId),
            eq(chainEvents.contractAddress, scope.contractAddress),
            eq(chainEvents.confirmationStatus, "observed"),
            gte(chainEvents.blockNumber, Number(range.from)),
          ),
        );

      await this.orphan(
        tx,
        scope,
        previous.filter((row) => !current.has(identity(row))),
      );

      if (events.length > 0) {
        await tx
          .insert(chainEvents)
          .values(this.rows(scope, events, "observed"))
          .onConflictDoUpdate({
            target: [
              chainEvents.chainId,
              chainEvents.txHash,
              chainEvents.logIndex,
            ],
            set: {
              blockNumber: sql`excluded.block_number`,
              blockHash: sql`excluded.block_hash`,
              payload: sql`excluded.payload`,
              eventName: sql`excluded.event_name`,
              onchainCampaignId: sql`excluded.onchain_campaign_id`,
              confirmationStatus: "observed",
            },
            // Never downgrade an event that is already confirmed.
            setWhere: ne(chainEvents.confirmationStatus, "confirmed"),
          });
      }

      const cursor = await this.getCursorWith(tx, scope);
      if (cursor) {
        await this.upsertCursor(tx, scope, {
          ...cursor,
          latestObservedBlock: range.to,
        });
      }
    });
  }

  async listCampaignEvents(
    scope: ChainScope,
    onchainCampaignId: string,
  ): Promise<StoredEvent[]> {
    const rows = await this.db
      .select()
      .from(chainEvents)
      .where(
        and(
          eq(chainEvents.chainId, scope.chainId),
          eq(chainEvents.contractAddress, scope.contractAddress),
          eq(chainEvents.onchainCampaignId, onchainCampaignId),
          inArray(chainEvents.confirmationStatus, ["observed", "confirmed"]),
        ),
      );

    return rows
      .map((row) => ({
        txHash: row.txHash,
        logIndex: row.logIndex,
        blockNumber: BigInt(row.blockNumber),
        blockHash: row.blockHash,
        event: row.payload as CampaignManagerEvent,
        status: row.confirmationStatus as ConfirmationStatus,
      }))
      .sort(byChainOrder);
  }

  async listConfirmedCreations(
    scope: ChainScope,
  ): Promise<
    { onchainCampaignId: string; advertiser: string; draftRef: string }[]
  > {
    const rows = await this.db
      .select({ payload: chainEvents.payload })
      .from(chainEvents)
      .where(
        and(
          eq(chainEvents.chainId, scope.chainId),
          eq(chainEvents.contractAddress, scope.contractAddress),
          eq(chainEvents.eventName, "CampaignCreated"),
          eq(chainEvents.confirmationStatus, "confirmed"),
        ),
      )
      .orderBy(asc(chainEvents.blockNumber), asc(chainEvents.logIndex));

    return rows.flatMap(({ payload }) => {
      const event = payload as CampaignManagerEvent;
      return event.name === "CampaignCreated"
        ? [
            {
              onchainCampaignId: event.campaignId,
              advertiser: event.advertiser,
              draftRef: event.draftRef,
            },
          ]
        : [];
    });
  }

  private async orphan(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    scope: ChainScope,
    rows: { txHash: string; logIndex: number }[],
  ) {
    for (const row of rows) {
      await tx
        .update(chainEvents)
        .set({ confirmationStatus: "orphaned" })
        .where(
          and(
            eq(chainEvents.chainId, scope.chainId),
            eq(chainEvents.txHash, row.txHash),
            eq(chainEvents.logIndex, row.logIndex),
          ),
        );
    }
  }

  private async getCursorWith(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    scope: ChainScope,
  ): Promise<IndexerCursor | null> {
    const [row] = await tx
      .select()
      .from(reconciliationState)
      .where(
        and(
          eq(reconciliationState.chainId, scope.chainId),
          eq(reconciliationState.contractAddress, scope.contractAddress),
        ),
      )
      .limit(1);

    return row
      ? {
          latestConfirmedBlock: BigInt(row.latestConfirmedBlock),
          latestConfirmedBlockHash: row.latestConfirmedBlockHash,
          latestObservedBlock: BigInt(row.latestObservedBlock),
        }
      : null;
  }

  private async upsertCursor(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    scope: ChainScope,
    cursor: IndexerCursor,
  ) {
    const values = {
      chainId: scope.chainId,
      contractAddress: scope.contractAddress,
      latestConfirmedBlock: Number(cursor.latestConfirmedBlock),
      latestConfirmedBlockHash: cursor.latestConfirmedBlockHash,
      latestObservedBlock: Number(cursor.latestObservedBlock),
      updatedAt: this.now(),
    };

    await tx
      .insert(reconciliationState)
      .values(values)
      .onConflictDoUpdate({
        target: [
          reconciliationState.chainId,
          reconciliationState.contractAddress,
        ],
        set: {
          latestConfirmedBlock: values.latestConfirmedBlock,
          latestConfirmedBlockHash: values.latestConfirmedBlockHash,
          latestObservedBlock: values.latestObservedBlock,
          updatedAt: values.updatedAt,
        },
      });
  }
}
