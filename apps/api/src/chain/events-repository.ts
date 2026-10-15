import type { CampaignManagerEvent } from "./abi.js";

export type ConfirmationStatus = "observed" | "confirmed" | "orphaned";

export interface IndexedEvent {
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string;
  event: CampaignManagerEvent;
}

export interface StoredEvent extends IndexedEvent {
  status: ConfirmationStatus;
}

export interface IndexerCursor {
  latestConfirmedBlock: bigint;
  latestConfirmedBlockHash: string | null;
  latestObservedBlock: bigint;
}

export interface ChainScope {
  chainId: number;
  contractAddress: string;
}

export interface ChainEventRepository {
  getCursor(scope: ChainScope): Promise<IndexerCursor | null>;
  /**
   * Atomically stores the canonical events of a confirmed block range,
   * orphans previously observed events in that range that are no longer
   * canonical, and advances the cursor.
   */
  commitConfirmedRange(
    scope: ChainScope,
    range: { from: bigint; to: bigint; toBlockHash: string },
    events: IndexedEvent[],
  ): Promise<void>;
  /**
   * Replaces the unconfirmed tail (blocks >= from): previously observed
   * events not seen again are orphaned. Never downgrades confirmed events.
   */
  replaceObservedTail(
    scope: ChainScope,
    range: { from: bigint; to: bigint },
    events: IndexedEvent[],
  ): Promise<void>;
  listCampaignEvents(
    scope: ChainScope,
    onchainCampaignId: string,
  ): Promise<StoredEvent[]>;
  /** Confirmed CampaignCreated events, oldest first. */
  listConfirmedCreations(
    scope: ChainScope,
  ): Promise<
    { onchainCampaignId: string; advertiser: string; draftRef: string }[]
  >;
  /**
   * Records that confirmed block `block` is no longer canonical (a reorg
   * deeper than the confirmation depth). Until cleared, the API accepts no
   * participation and signs nothing for this deployment (ADR-0011).
   */
  haltForReorg(scope: ChainScope, block: bigint, at: Date): Promise<void>;
  getHalt(scope: ChainScope): Promise<ChainHalt | null>;
  /**
   * Drops every indexed event, the cursor and any halt for `scope`, so the
   * worker rebuilds the index from the deploy block. Recovery only.
   */
  resetIndex(scope: ChainScope): Promise<void>;
}

export interface ChainHalt {
  block: bigint;
  at: Date;
}

export const identity = (event: { txHash: string; logIndex: number }) =>
  `${event.txHash}:${event.logIndex}`;

export function campaignIdOf(event: CampaignManagerEvent): string | null {
  return "campaignId" in event ? event.campaignId : null;
}

export function byChainOrder(left: StoredEvent, right: StoredEvent): number {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }

  return left.logIndex - right.logIndex;
}

/** Same semantics as the PostgreSQL repository, for unit tests. */
export class InMemoryChainEventRepository implements ChainEventRepository {
  private readonly events = new Map<string, StoredEvent & ChainScope>();
  private readonly cursors = new Map<string, IndexerCursor>();
  private readonly halts = new Map<string, ChainHalt>();

  async haltForReorg(scope: ChainScope, block: bigint, at: Date) {
    this.halts.set(this.key(scope), { block, at });
  }

  async getHalt(scope: ChainScope): Promise<ChainHalt | null> {
    return this.halts.get(this.key(scope)) ?? null;
  }

  async resetIndex(scope: ChainScope): Promise<void> {
    for (const [key, stored] of this.events) {
      if (
        stored.chainId === scope.chainId &&
        stored.contractAddress === scope.contractAddress
      ) {
        this.events.delete(key);
      }
    }
    this.cursors.delete(this.key(scope));
    this.halts.delete(this.key(scope));
  }

  private key(scope: ChainScope) {
    return `${scope.chainId}:${scope.contractAddress}`;
  }

  async getCursor(scope: ChainScope): Promise<IndexerCursor | null> {
    return this.cursors.get(this.key(scope)) ?? null;
  }

  private inScope(scope: ChainScope) {
    return [...this.events.values()].filter(
      (event) =>
        event.chainId === scope.chainId &&
        event.contractAddress === scope.contractAddress,
    );
  }

  async commitConfirmedRange(
    scope: ChainScope,
    range: { from: bigint; to: bigint; toBlockHash: string },
    events: IndexedEvent[],
  ): Promise<void> {
    const canonical = new Set(events.map(identity));

    for (const stored of this.inScope(scope)) {
      if (
        stored.status === "observed" &&
        stored.blockNumber >= range.from &&
        stored.blockNumber <= range.to &&
        !canonical.has(identity(stored))
      ) {
        stored.status = "orphaned";
      }
    }

    for (const event of events) {
      this.events.set(`${scope.chainId}:${identity(event)}`, {
        ...event,
        ...scope,
        status: "confirmed",
      });
    }

    this.cursors.set(this.key(scope), {
      latestConfirmedBlock: range.to,
      latestConfirmedBlockHash: range.toBlockHash,
      latestObservedBlock: range.to,
    });
  }

  async replaceObservedTail(
    scope: ChainScope,
    range: { from: bigint; to: bigint },
    events: IndexedEvent[],
  ): Promise<void> {
    const current = new Set(events.map(identity));

    for (const stored of this.inScope(scope)) {
      if (
        stored.status === "observed" &&
        stored.blockNumber >= range.from &&
        !current.has(identity(stored))
      ) {
        stored.status = "orphaned";
      }
    }

    for (const event of events) {
      const key = `${scope.chainId}:${identity(event)}`;
      if (this.events.get(key)?.status !== "confirmed") {
        this.events.set(key, { ...event, ...scope, status: "observed" });
      }
    }

    const cursor = this.cursors.get(this.key(scope));
    if (cursor) {
      this.cursors.set(this.key(scope), {
        ...cursor,
        latestObservedBlock: range.to,
      });
    }
  }

  async listCampaignEvents(
    scope: ChainScope,
    onchainCampaignId: string,
  ): Promise<StoredEvent[]> {
    return this.inScope(scope)
      .filter(
        (event) =>
          event.status !== "orphaned" &&
          campaignIdOf(event.event) === onchainCampaignId,
      )
      .map(({ txHash, logIndex, blockNumber, blockHash, event, status }) => ({
        txHash,
        logIndex,
        blockNumber,
        blockHash,
        event,
        status,
      }))
      .sort(byChainOrder);
  }

  async listConfirmedCreations(
    scope: ChainScope,
  ): Promise<
    { onchainCampaignId: string; advertiser: string; draftRef: string }[]
  > {
    return this.inScope(scope)
      .filter((stored) => stored.status === "confirmed")
      .sort(byChainOrder)
      .flatMap((stored) =>
        stored.event.name === "CampaignCreated"
          ? [
              {
                onchainCampaignId: stored.event.campaignId,
                advertiser: stored.event.advertiser,
                draftRef: stored.event.draftRef,
              },
            ]
          : [],
      );
  }

  /** Test helper. */
  allEvents(): (StoredEvent & ChainScope)[] {
    return [...this.events.values()];
  }
}
