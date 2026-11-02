import { campaignManagerAbi } from "@vham/shared/contracts";
import type { Address, Hex, PublicClient } from "viem";

import { ApiError } from "./api";
import { describeSimulationFailure, revertName } from "./settlement";

/** A signed claim authorization as the API returns it. */
export interface Authorization {
  campaignId: string;
  /** The campaign's draft reference, checked by the contract (ADR-0011). */
  draftRef: Hex;
  claimant: Address;
  amount: string;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
  signature: Hex;
  contractAddress: Address;
}

/**
 * Reverts that mean the reward is already in the wallet: the authorization's
 * nonce was redeemed, or the wallet already claimed this campaign (the
 * contract pays each wallet once per campaign).
 */
const ALREADY_PAID_REVERTS = new Set([
  "NonceAlreadyUsed",
  "WalletAlreadyClaimed",
]);

/**
 * The claim cannot go through because the reward was already paid: the API
 * answered ALREADY_CLAIMED, or simulating `claim` reverted with
 * NonceAlreadyUsed or WalletAlreadyClaimed (#82).
 */
export function isAlreadyPaid(error: unknown): boolean {
  if (error instanceof ApiError) return error.code === "ALREADY_CLAIMED";
  const name = revertName(error);
  return name !== undefined && ALREADY_PAID_REVERTS.has(name);
}

/** The `claim` transaction for `auth`, sent from `account`. */
export function claimCall(account: Address, auth: Authorization) {
  return {
    account,
    address: auth.contractAddress,
    abi: campaignManagerAbi,
    functionName: "claim",
    args: [
      {
        campaignId: BigInt(auth.campaignId),
        draftRef: auth.draftRef,
        claimant: auth.claimant,
        amount: BigInt(auth.amount),
        nonce: auth.nonce,
        issuedAt: BigInt(auth.issuedAt),
        expiresAt: BigInt(auth.expiresAt),
      },
      auth.signature,
    ],
  } as const;
}

/**
 * Simulates `claim` before the wallet is asked to send it, as the advertiser
 * page does for close and refund. A reward that was already paid (a claim
 * mined after the API's live read, from another tab for instance) comes back
 * as "already-paid", so no transaction is opened. Any other revert throws
 * with the contract's error name; nothing was sent.
 */
export async function simulateClaim(
  publicClient: Pick<PublicClient, "simulateContract">,
  call: ReturnType<typeof claimCall>,
): Promise<"ready" | "already-paid"> {
  try {
    await publicClient.simulateContract(call);
    return "ready";
  } catch (caught) {
    if (isAlreadyPaid(caught)) return "already-paid";
    throw new Error(describeSimulationFailure(caught), { cause: caught });
  }
}
