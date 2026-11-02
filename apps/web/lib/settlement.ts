import { campaignManagerAbi } from "@vham/shared/contracts";
import {
  isDraftCampaign,
  type Deployment,
  type DraftCampaignExpectation,
} from "@vham/shared/deployment";
import {
  parseClosedAt,
  parseStoredCampaignStatus,
  type SettlementReading,
} from "@vham/shared/settlement";
import {
  BaseError,
  ContractFunctionRevertedError,
  getAddress,
  TransactionNotFoundError,
  type Hash,
} from "viem";

import type { Wallet } from "./wallet";

export interface SettlementTarget extends DraftCampaignExpectation {
  draftRef: Hash;
}

export interface ChainSettlement {
  reading: SettlementReading;
  readAtLocalMs: number;
}

export type SettlementAction = "close" | "refund";

export const SETTLEMENT_CALLS = {
  close: {
    functionName: "closeCampaign",
    label: "Close campaign",
    done: "Campaign closed",
  },
  refund: {
    functionName: "refundUnusedBudget",
    label: "Refund unused budget",
    done: "Unused budget refunded",
  },
} as const;

/**
 * Whether a campaign status shows that `action` took effect: closeCampaign
 * stores `closed`, refundUnusedBudget `settled`. Takes the contract's stored
 * status or the API's indexed one.
 */
export function settlementEffectVisible(
  action: SettlementAction,
  status: string | null | undefined,
): boolean {
  return status === "settled" || (action === "close" && status === "closed");
}

export type SettlementButton =
  | { kind: "hidden" }
  /** The normal button. */
  | { kind: "send"; disabled: boolean }
  /** The earlier transaction was probably never broadcast: send it anyway, with a warning. */
  | { kind: "send-anyway"; disabled: boolean };

/**
 * Close and Refund stay in place while another action runs (only disabled),
 * like Create and Fund, so a second click never lands on the button that
 * would slide into their spot. While the page waits for an action's effect
 * its button is hidden; only when that transaction was probably never
 * broadcast (`maybeDropped`) is a separate "anyway" button offered.
 */
export function settlementButton(
  action: SettlementAction,
  verdict: { kind: string } | null,
  {
    awaitingEffect,
    maybeDropped,
    blocked,
  }: {
    awaitingEffect: SettlementAction | null;
    maybeDropped: SettlementAction | null;
    blocked: boolean;
  },
): SettlementButton {
  if (verdict?.kind !== "available") return { kind: "hidden" };
  if (awaitingEffect !== action) return { kind: "send", disabled: blocked };
  return maybeDropped === action
    ? { kind: "send-anyway", disabled: blocked }
    : { kind: "hidden" };
}

/** How often an unknown close or refund outcome is checked again. */
export const SETTLEMENT_POLL_MS = 10_000;

/**
 * After this long a transaction the wallet's node has never returned (so
 * its nonce is unknown) is taken as probably not broadcast, and a separate,
 * warned "anyway" button is offered. A transaction seen once keeps its nonce
 * slot; only another transaction using that nonce settles it ("replaced").
 */
export const ASSUME_DROPPED_AFTER_MS = 10 * 60_000;

export interface SettlementTxObservation {
  receipt: "success" | "reverted" | null;
  /** false: the node does not know the hash; null: it could not be asked. */
  known: boolean | null;
  txNonce: number | null;
  /** The sender's mined transaction count (next nonce); null when unread. */
  minedNonce: number | null;
}

const UNOBSERVED: SettlementTxObservation = {
  receipt: null,
  known: null,
  txNonce: null,
  minedNonce: null,
};

/**
 * Reads what the wallet's node knows about a close or refund transaction.
 * The sender's nonce is read before the receipt: if the nonce was used and
 * this hash still has no receipt, another transaction replaced it. Any read
 * that fails is "unknown", never a failure.
 */
export async function observeSettlementTx(
  wallet: Pick<Wallet, "address" | "publicClient">,
  chainId: number,
  hash: Hash,
  knownNonce: number | null,
): Promise<SettlementTxObservation> {
  const { publicClient } = wallet;
  const onChain = await publicClient.getChainId().then(
    (current) => current === chainId,
    () => false,
  );
  // On another network every lookup would come back "not found".
  if (!onChain) return { ...UNOBSERVED, txNonce: knownNonce };

  let known: boolean | null = null;
  let txNonce = knownNonce;
  try {
    txNonce = (await publicClient.getTransaction({ hash })).nonce;
    known = true;
  } catch (caught) {
    if (caught instanceof TransactionNotFoundError) known = false;
  }

  const minedNonce =
    txNonce === null
      ? null
      : await publicClient
          .getTransactionCount({ address: wallet.address, blockTag: "latest" })
          .catch(() => null);
  const receipt = await publicClient.getTransactionReceipt({ hash }).then(
    (mined) => (mined.status === "success" ? "success" : "reverted"),
    () => null,
  );

  return { receipt, known, txNonce, minedNonce };
}

export type SettlementTxOutcome =
  "done" | "reverted" | "replaced" | "dropped" | "pending";

/**
 * Judges one check of an unknown close or refund outcome. The chain's status
 * decides first (the effect may come from a sped-up replacement), then the
 * receipt, then the sender's nonce. Once the transaction was seen with nonce
 * N, it stays pending while the mined nonce is still <= N: the slot is
 * empty and the transaction can still land; only "replaced" concludes it.
 * "Dropped" (not final) is only for a hash never seen, after
 * ASSUME_DROPPED_AFTER_MS. "Replaced" and "dropped" also need a fresh read
 * of the campaign (`storedStatus`) showing no effect.
 */
export function resolveSettlementTx({
  action,
  storedStatus,
  observation,
  elapsedMs,
}: {
  action: SettlementAction;
  /** From a read made after the observation; null when it failed. */
  storedStatus: string | null;
  observation: SettlementTxObservation;
  elapsedMs: number;
}): SettlementTxOutcome {
  if (
    settlementEffectVisible(action, storedStatus) ||
    observation.receipt === "success"
  ) {
    return "done";
  }
  if (observation.receipt === "reverted") return "reverted";
  if (storedStatus === null) return "pending";
  if (observation.txNonce !== null) {
    return observation.minedNonce !== null &&
      observation.minedNonce > observation.txNonce
      ? "replaced"
      : "pending";
  }
  return observation.known === false && elapsedMs >= ASSUME_DROPPED_AFTER_MS
    ? "dropped"
    : "pending";
}

/** Verdicts after which the transaction is no longer checked. */
export type FinalSettlementTxOutcome = Exclude<
  SettlementTxOutcome,
  "pending" | "dropped"
>;

const isFinal = (
  outcome: SettlementTxOutcome,
): outcome is FinalSettlementTxOutcome =>
  outcome !== "pending" && outcome !== "dropped";

/**
 * Checks an unknown close or refund outcome every `intervalMs`. A verdict
 * counts only when two consecutive checks agree, because the wallet's RPC
 * can answer from different backends; a failed check breaks the streak.
 * `onVerdict` hears every agreed change: "dropped" (not final, the checks go
 * on and may return to "pending"), then one final verdict, after which the
 * checks stop. Returns a function that stops them.
 */
export function pollSettlementTx(
  check: () => Promise<SettlementTxOutcome>,
  onVerdict: (outcome: SettlementTxOutcome) => void,
  intervalMs = SETTLEMENT_POLL_MS,
): () => void {
  let stopped = false;
  let checking = false;
  let previous: SettlementTxOutcome | null = null;
  let reported: SettlementTxOutcome = "pending";

  const timer = setInterval(() => {
    if (checking || stopped) return;
    checking = true;
    void check()
      .then((outcome) => {
        if (stopped) return;
        const agreed = outcome === previous;
        previous = outcome;
        if (!agreed || outcome === reported) return;
        reported = outcome;
        if (isFinal(outcome)) stop();
        onVerdict(outcome);
      })
      .catch(() => {
        previous = null;
      })
      .finally(() => {
        checking = false;
      });
  }, intervalMs);

  function stop() {
    stopped = true;
    clearInterval(timer);
  }
  return stop;
}

export const SETTLEMENT_TX_MESSAGES: Record<
  Exclude<FinalSettlementTxOutcome, "done">,
  string
> = {
  reverted: "The transaction reverted.",
  replaced:
    "Your wallet used this transaction's nonce for another transaction (cancelled or replaced), and the campaign is unchanged.",
};

/**
 * Whether the card still shows `hash` waiting or failed, so that the
 * effect showing on-chain later turns it into done: a verdict from one
 * lagging backend is corrected instead of standing.
 */
export function cardFlipsToDone(
  card: { state: string; hash?: Hash | null },
  hash: Hash,
): boolean {
  return (
    (card.state === "reconciling" || card.state === "failed") &&
    card.hash === hash
  );
}

export function formatRemaining(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours} h ${minutes} min`;
  return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

export async function readSettlement(
  wallet: Wallet,
  deployment: Deployment,
  target: SettlementTarget,
): Promise<ChainSettlement> {
  const { publicClient } = wallet;
  if ((await publicClient.getChainId()) !== deployment.chainId) {
    throw new Error("Switch your wallet to the campaign's network first.");
  }

  const contract = {
    address: getAddress(deployment.contractAddress),
    abi: campaignManagerAbi,
  } as const;

  const [maxAuthorizationTtl, mappedCampaignId, onchain, paused, block] =
    await Promise.all([
      publicClient.readContract({
        ...contract,
        functionName: "MAX_AUTHORIZATION_TTL",
      }),
      publicClient.readContract({
        ...contract,
        functionName: "campaignIdByDraft",
        args: [wallet.address, target.draftRef],
      }),
      publicClient.readContract({
        ...contract,
        functionName: "campaigns",
        args: [BigInt(target.onchainCampaignId)],
      }),
      publicClient.readContract({ ...contract, functionName: "paused" }),
      publicClient.getBlock(),
    ]);

  if (
    !isDraftCampaign(
      {
        mappedCampaignId,
        onchain: {
          rewardPerCompletion: onchain[3],
          maxCompletions: onchain[4],
          startTime: onchain[6],
          endTime: onchain[7],
        },
      },
      target,
    )
  ) {
    throw new Error(
      "The on-chain campaign does not match this draft, so nothing was sent. Refresh the page; if it persists, the chain may be recovering.",
    );
  }

  return {
    reading: {
      storedStatus: parseStoredCampaignStatus(onchain[9]),
      endTime: onchain[7],
      closedAt: parseClosedAt(onchain[8]),
      maxAuthorizationTtl,
      paused,
      blockTimestamp: block.timestamp,
    },
    readAtLocalMs: Date.now(),
  };
}

export function describeChainError(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : "Unexpected error";
}

/** The contract's custom error name in a viem error, if it reverted. */
export function revertName(error: unknown): string | undefined {
  const reverted =
    error instanceof BaseError
      ? error.walk((cause) => cause instanceof ContractFunctionRevertedError)
      : null;
  return reverted instanceof ContractFunctionRevertedError
    ? reverted.data?.errorName
    : undefined;
}

export function describeSimulationFailure(error: unknown): string {
  const name = revertName(error);

  return name
    ? `The contract would reject this transaction (${name}), so nothing was sent.`
    : `${describeChainError(error)} Nothing was sent.`;
}
