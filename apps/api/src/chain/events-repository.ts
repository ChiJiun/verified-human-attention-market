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

/**
 * The stored cursor is not the one the writer extends: `reorg:recover
 * --apply` reset the index, or another writer moved it, after the writer
 * read it. Nothing was written; the next pass starts from the stored cursor.
 * Every write extends the cursor it read, so the index stays contiguous from
 * the deploy block (#77).
 */
export class IndexCursorMovedError extends Error {
  constructor(
    readonly expected: bigint | null,
    readonly actual: bigint | null,
  ) {
    super(
      `Index cursor moved (expected ${expected ?? "none"}, found ${actual ?? "none"}); nothing written`,
    );
    this.name = "IndexCursorMovedError";
  }
}

/** Held by one indexer worker, or by `reorg:recover --apply`. */
export interface DeploymentLock {
  /**
   * Whether this holder still has it. False once its database session
   * ended (restart, failover, network, idle_session_timeout): the server
   * released the lock with it, so another process may now hold it. Throws
   * when the database cannot be asked.
   */
  isHeld(): Promise<boolean>;
  /** Never throws: a lock whose session is gone is released already. */
  release(): Promise<void>;
}

export interface ChainEventRepository {
  getCursor(scope: ChainScope): Promise<IndexerCursor | null>;
  /**
   * Atomically stores the canonical events of a confirmed block range,
   * orphans previously observed events in that range that are no longer
   * canonical, and advances the cursor. `expectedCursor` is the confirmed
   * block the caller read from the cursor (null: no cursor, so the range
   * starts at the deploy block); IndexCursorMovedError otherwise.
   */
  commitConfirmedRange(
    scope: ChainScope,
    range: {
      from: bigint;
      to: bigint;
      toBlockHash: string;
      expectedCursor: bigint | null;
    },
    events: IndexedEvent[],
  ): Promise<void>;
  /**
   * Replaces the unconfirmed tail (blocks >= from): previously observed
   * events not seen again are orphaned. Never downgrades confirmed events.
   * Refuses like commitConfirmedRange when the cursor moved.
   */
  replaceObservedTail(
    scope: ChainScope,
    range: { from: bigint; to: bigint; expectedCursor: bigint | null },
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
   * deeper than the confirmation depth). While a halt exists the API accepts
   * no participation and signs nothing for this deployment (ADR-0011). A new
   * halt also cancels a recovery in progress.
   */
  haltForReorg(scope: ChainScope, block: bigint, at: Date): Promise<void>;
  getHalt(scope: ChainScope): Promise<ChainHalt | null>;
  /**
   * `reorg:recover --apply` finished releasing links and dropping the index;
   * the worker may now rebuild. The halt itself stays. Returns false when
   * there is no halt.
   */
  markRecoveryApplied(scope: ChainScope, at: Date): Promise<boolean>;
  /**
   * Only the worker, after the rebuilt index and every link verify. Deletes
   * the halt only while its `recoveryAppliedAt` is still the one the worker
   * rebuilt for (a recovery applied again, or a new halt, keeps it) and the
   * stored cursor still reaches `indexedThrough` (an index reset since the
   * verification keeps it). Returns whether it was deleted.
   */
  clearHalt(
    scope: ChainScope,
    verified: { recoveryAppliedAt: Date; indexedThrough: bigint },
  ): Promise<boolean>;
  /**
   * Drops every indexed event and the cursor for `scope`, so the worker
   * rebuilds the index from the deploy block. Never touches the halt.
   */
  resetIndex(scope: ChainScope): Promise<void>;
  /**
   * Takes the deployment for one indexer worker or one `reorg:recover
   * --apply`; null while another process holds it. Released by `release()`
   * or when the holder's process (database session) ends.
   */
  lockDeployment(scope: ChainScope): Promise<DeploymentLock | null>;
  /** Whether any process holds the deployment, without taking it. */
  isDeploymentLocked(scope: ChainScope): Promise<boolean>;
}

export interface ChainHalt {
  block: bigint;
  at: Date;
  /** null until `reorg:recover --apply`; then the worker may rebuild. */
  recoveryAppliedAt: Date | null;
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
  /** Deployment key → the holder's token. */
  private readonly locks = new Map<string, symbol>();

  async haltForReorg(scope: ChainScope, block: bigint, at: Date) {
    this.halts.set(this.key(scope), { block, at, recoveryAppliedAt: null });
  }

  async getHalt(scope: ChainScope): Promise<ChainHalt | null> {
    return this.halts.get(this.key(scope)) ?? null;
  }

  async markRecoveryApplied(scope: ChainScope, at: Date): Promise<boolean> {
    const halt = this.halts.get(this.key(scope));
    if (!halt) return false;
    this.halts.set(this.key(scope), { ...halt, recoveryAppliedAt: at });
    return true;
  }

  async clearHalt(
    scope: ChainScope,
    verified: { recoveryAppliedAt: Date; indexedThrough: bigint },
  ): Promise<boolean> {
    const halt = this.halts.get(this.key(scope));
    const cursor = this.cursors.get(this.key(scope));
    if (
      halt?.recoveryAppliedAt?.getTime() !==
        verified.recoveryAppliedAt.getTime() ||
      !cursor ||
      cursor.latestConfirmedBlock < verified.indexedThrough
    ) {
      return false;
    }
    this.halts.delete(this.key(scope));
    return true;
  }

  async lockDeployment(scope: ChainScope): Promise<DeploymentLock | null> {
    const key = this.key(scope);
    if (this.locks.has(key)) return null;
    const token = Symbol(key);
    this.locks.set(key, token);
    return {
      isHeld: async () => this.locks.get(key) === token,
      release: async () => {
        if (this.locks.get(key) === token) this.locks.delete(key);
      },
    };
  }

  async isDeploymentLocked(scope: ChainScope): Promise<boolean> {
    return this.locks.has(this.key(scope));
  }

  /** Test helper: every holder's database session ended. */
  dropDeploymentLocks() {
    this.locks.clear();
  }

  /** Same check as the PostgreSQL repository's, inside its transaction. */
  private expectCursor(scope: ChainScope, expected: bigint | null) {
    const actual =
      this.cursors.get(this.key(scope))?.latestConfirmedBlock ?? null;
    if (actual !== expected) {
      throw new IndexCursorMovedError(expected, actual);
    }
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
    range: {
      from: bigint;
      to: bigint;
      toBlockHash: string;
      expectedCursor: bigint | null;
    },
    events: IndexedEvent[],
  ): Promise<void> {
    this.expectCursor(scope, range.expectedCursor);
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
    range: { from: bigint; to: bigint; expectedCursor: bigint | null },
    events: IndexedEvent[],
  ): Promise<void> {
    this.expectCursor(scope, range.expectedCursor);
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
