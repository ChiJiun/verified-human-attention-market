import type { Deployment } from "@vham/shared/deployment";
import {
  parseStoredCampaignStatus,
  type StoredCampaignStatus,
} from "@vham/shared/settlement";
import { getAddress, parseAbi } from "viem";

import {
  readDraftCampaign,
  SETTLEMENT_CALLS,
  SETTLEMENT_TX_MESSAGES,
  settlementButton,
  type FinalSettlementTxOutcome,
  type SettlementTarget,
  type TrackedAction,
} from "./settlement";
import type { Wallet } from "./wallet";

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

/** The two transactions behind "Approve & fund". */
export type FundingAction = Extract<TrackedAction, "approve" | "fund">;

export function isFundingAction(
  action: TrackedAction | null,
): action is FundingAction {
  return action === "approve" || action === "fund";
}

export const FUNDING_CALLS = {
  approve: { label: "Approve USDC", done: "USDC approved" },
  fund: {
    label: "Fund campaign",
    done: "Funded — activates after confirmations",
  },
} as const;

type FailedOutcome = Exclude<FinalSettlementTxOutcome, "done">;

const FUNDING_TX_MESSAGES: Record<
  FundingAction,
  Record<FailedOutcome, string>
> = {
  approve: {
    reverted: SETTLEMENT_TX_MESSAGES.reverted,
    replaced:
      "Your wallet used this transaction's nonce for another transaction (cancelled or replaced), and the USDC allowance is unchanged.",
  },
  // "... and the campaign is unchanged": still not funded.
  fund: SETTLEMENT_TX_MESSAGES,
};

/** The card's label and done text for any tracked transaction. */
export function trackedCall(action: TrackedAction): {
  label: string;
  done: string;
} {
  return isFundingAction(action)
    ? FUNDING_CALLS[action]
    : SETTLEMENT_CALLS[action];
}

/** The card's message once a tracked transaction failed. */
export function trackedFailure(
  action: TrackedAction,
  outcome: FailedOutcome,
): string {
  return isFundingAction(action)
    ? FUNDING_TX_MESSAGES[action][outcome]
    : SETTLEMENT_TX_MESSAGES[outcome];
}

/** How the page names a tracked transaction in prose. */
export function trackedNoun(action: TrackedAction): string {
  return action === "approve"
    ? "approval"
    : action === "fund"
      ? "funding"
      : action;
}

/** CampaignManager and the USDC it is funded in, as GET /v1/chain names them. */
export interface FundingDeployment extends Deployment {
  usdc: string;
}

/**
 * fundCampaign's amount: rewardPerCompletion × maxCompletions in USDC
 * atomic units, as the contract computes it (never floating point).
 */
export function requiredBudget({
  rewardPerCompletion,
  maxCompletions,
}: {
  rewardPerCompletion: string;
  maxCompletions: number;
}): bigint {
  return BigInt(rewardPerCompletion) * BigInt(maxCompletions);
}

export interface FundingReading {
  /** USDC (atomic units) the advertiser lets CampaignManager move. */
  allowance: bigint;
  storedStatus: StoredCampaignStatus;
  /** Atomic units; 0 until fundCampaign. */
  fundedBudget: bigint;
}

/**
 * Reads, in the wallet's own chain view, what Approve and Fund change: the
 * USDC allowance (owner = advertiser, spender = CampaignManager) and the
 * campaign, after checking that its id still belongs to this draft
 * (ADR-0011). Throws on another network or a mismatch.
 */
export async function readFunding(
  wallet: Pick<Wallet, "address" | "publicClient">,
  deployment: FundingDeployment,
  target: SettlementTarget,
): Promise<FundingReading> {
  const { publicClient } = wallet;
  if ((await publicClient.getChainId()) !== deployment.chainId) {
    throw new Error("Switch your wallet to the campaign's network first.");
  }

  const manager = getAddress(deployment.contractAddress);
  const [allowance, onchain] = await Promise.all([
    publicClient.readContract({
      address: getAddress(deployment.usdc),
      abi: erc20Abi,
      functionName: "allowance",
      args: [wallet.address, manager],
    }),
    readDraftCampaign(wallet, manager, target),
  ]);
  if (!onchain) {
    throw new Error(
      "The on-chain campaign does not match this draft, so nothing was funded. Refresh the page; if it persists, the chain may be recovering.",
    );
  }

  return {
    allowance,
    storedStatus: parseStoredCampaignStatus(onchain[9]),
    fundedBudget: onchain[1],
  };
}

/** Statuses a campaign only reaches through fundCampaign. */
const FUNDED_STATUSES: readonly string[] = ["active", "closed", "settled"];

/**
 * fundCampaign's effect on-chain: funded with exactly the budget. It stays
 * funded through close and refund.
 */
export function fundedOnchain(
  reading: FundingReading,
  required: bigint,
): boolean {
  return (
    reading.fundedBudget === required &&
    FUNDED_STATUSES.includes(reading.storedStatus)
  );
}

/** What GET /v1/campaigns/:id/analytics says about the funding. */
export interface IndexedFunding {
  status: string;
  settlement: { pending: { status: string; funded: string } } | null;
}

/**
 * Whether the API's index shows the funding: its campaign status, or the
 * indexed events including those not confirmed yet.
 */
export function fundedIndexed(indexed: IndexedFunding | null): boolean {
  if (!indexed) return false;
  const pending = indexed.settlement?.pending;
  return (
    FUNDED_STATUSES.includes(indexed.status) ||
    (pending !== undefined &&
      (FUNDED_STATUSES.includes(pending.status) || BigInt(pending.funded) > 0n))
  );
}

export function allowanceCovers(
  reading: FundingReading | null,
  required: bigint,
): boolean {
  return reading !== null && reading.allowance >= required;
}

/** What the page knows about a campaign's funding. */
export interface FundingView {
  /** requiredBudget of the campaign. */
  required: bigint;
  /** The wallet's last readFunding; null when unread. */
  reading: FundingReading | null;
  indexed?: IndexedFunding | null;
  /**
   * The page saw it funded before, on-chain or in the index. It stays
   * funded: the allowance and the campaign are separate calls that a load
   * balancer can answer from different backends, and a lagging read must
   * not bring back Approve & fund, which would send a surplus approval.
   */
  seenFunded?: boolean;
}

/**
 * Whether `action` took effect, whichever transaction caused it (a sped-up
 * replacement, another tab). Fund: the campaign is funded with its budget,
 * on-chain or in the API's index (or was seen so). Approve: the allowance
 * covers the budget, or the campaign is funded already (which spent the
 * allowance).
 */
export function fundingEffectVisible(
  action: FundingAction,
  { required, reading, indexed = null, seenFunded = false }: FundingView,
): boolean {
  const funded =
    seenFunded ||
    fundedIndexed(indexed) ||
    (reading !== null && fundedOnchain(reading, required));
  return funded || (action === "approve" && allowanceCovers(reading, required));
}

/**
 * Whether the funding button is offered at all: the campaign is linked on
 * the current deployment, the API has it awaiting funding, and the page has
 * never seen it funded.
 */
export function fundingOffered(
  status: string | undefined,
  currentDeployment: boolean,
  view: FundingView | null,
): boolean {
  return (
    view !== null &&
    status === "pending_onchain" &&
    currentDeployment &&
    !fundingEffectVisible("fund", view)
  );
}

/**
 * Why fundCampaign would only revert and cost gas, or null when it can
 * still succeed (a draft with nothing funded). Checked right before the
 * wallet is asked, so an "anyway" send after the first one landed is not
 * sent at all.
 */
export function fundingRefusal(
  reading: FundingReading,
  required: bigint,
): string | null {
  if (fundedOnchain(reading, required)) {
    return "This campaign is already funded on-chain, so nothing was sent. The page updates once the funding is confirmed.";
  }
  if (reading.storedStatus !== "draft" || reading.fundedBudget !== 0n) {
    return `The on-chain campaign is ${reading.storedStatus} and can no longer be funded, so nothing was sent.`;
  }
  return null;
}

export type FundingStep =
  { kind: "approve" } | { kind: "fund" } | { kind: "refuse"; message: string };

export const ALLOWANCE_BELOW_BUDGET =
  "The USDC allowance does not cover the budget now, so nothing was funded. Another tab or a spending cap set in your wallet may have changed it, or your wallet's network does not show the approval yet. Press Approve & fund to read it again; it approves again only if the allowance is still too low.";

/**
 * What the funding button does next with a fresh reading, made right before
 * each send: refuse (nothing is sent), approve first, or fund. Once this
 * press has approved (`approved`), an allowance below the budget is refused
 * rather than approved again: the approval wait can take minutes, and the
 * allowance is shared by every approval from this wallet to CampaignManager.
 */
export function nextFundingStep(
  reading: FundingReading,
  required: bigint,
  { approved }: { approved: boolean },
): FundingStep {
  const refusal = fundingRefusal(reading, required);
  if (refusal) return { kind: "refuse", message: refusal };
  if (allowanceCovers(reading, required)) return { kind: "fund" };
  return approved
    ? { kind: "refuse", message: ALLOWANCE_BELOW_BUDGET }
    : { kind: "approve" };
}

export type FundingButton =
  | { kind: "hidden" }
  | { kind: "send" | "send-anyway"; step: FundingAction; disabled: boolean };

/**
 * The one funding button, by the rule of the close and refund buttons
 * (settlementButton). "Approve & fund" until the allowance covers the
 * budget, then "Fund campaign": the next step after an approval. While an
 * approve or fund may still land it is hidden; only for one never seen
 * (`maybeDropped`) is the warned "anyway" send of that step offered.
 */
export function fundingButton(
  offered: boolean,
  covered: boolean,
  state: {
    awaitingEffect: TrackedAction | null;
    maybeDropped: TrackedAction | null;
    blocked: boolean;
  },
): FundingButton {
  const awaiting = isFundingAction(state.awaitingEffect)
    ? state.awaitingEffect
    : null;
  const step: FundingAction = awaiting ?? (covered ? "fund" : "approve");
  const button = settlementButton(
    step,
    offered ? { kind: "available" } : null,
    { ...state, awaitingEffect: awaiting },
  );
  return button.kind === "hidden" ? button : { ...button, step };
}

export function fundingButtonLabel(
  button: Exclude<FundingButton, { kind: "hidden" }>,
): string {
  const label = button.step === "approve" ? "Approve & fund" : "Fund campaign";
  return button.kind === "send-anyway" ? `${label} anyway` : label;
}

export const FUNDING_ANYWAY_TITLES: Record<FundingAction, string> = {
  approve:
    "Your wallet's network has not seen the earlier approval. If it is mined after all, this one sets the same allowance again and only costs gas.",
  fund: "Your wallet's network has not seen the earlier funding. If it is mined after all, this one reverts and only costs gas.",
};
