import { campaignManagerAbi } from "@vham/shared/contracts";
import type { Address, Hex, PublicClient, WalletClient } from "viem";

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
 * The wallet must still be on the campaign's chain: it can switch after it
 * was connected, and the same address on another chain is another contract
 * or none at all (where an empty `eth_call` result reads as success).
 */
export async function assertClaimChain(
  walletClient: Pick<WalletClient, "getChainId">,
  expected: { id: number; name: string },
): Promise<void> {
  if ((await walletClient.getChainId()) !== expected.id) {
    throw new Error(
      `Switch your wallet to ${expected.name}, then press Claim USDC again. Nothing was sent.`,
    );
  }
}

/** How long a just-signed authorization may wait for a block at its issuedAt. */
export interface BlockWait {
  waitMs: number;
  pollMs: number;
}

const BLOCK_WAIT: BlockWait = { waitMs: 15_000, pollMs: 1_000 };

/**
 * Simulates `claim` before the wallet is asked to send it, as the advertiser
 * page does for close and refund. A reward that was already paid (a claim
 * mined after the API's live read, from another tab for instance) comes back
 * as "already-paid", so no transaction is opened. Any other revert throws
 * with the contract's error name; nothing was sent.
 *
 * The API signs with `issuedAt` = now, and the simulation runs on the latest
 * block, usually a second or two older, where the contract answers
 * AuthorizationNotYetValid. That revert waits (bounded) for a block at or
 * after `issuedAt` and simulates once more.
 */
export async function simulateClaim(
  publicClient: Pick<PublicClient, "simulateContract" | "getBlock">,
  call: ReturnType<typeof claimCall>,
  blockWait: BlockWait = BLOCK_WAIT,
): Promise<"ready" | "already-paid"> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await publicClient.simulateContract(call);
      return "ready";
    } catch (caught) {
      if (isAlreadyPaid(caught)) return "already-paid";
      if (
        attempt === 0 &&
        revertName(caught) === "AuthorizationNotYetValid" &&
        (await blockReaches(publicClient, call.args[0].issuedAt, blockWait))
      ) {
        continue;
      }
      throw new Error(describeSimulationFailure(caught), { cause: caught });
    }
  }
}

/** Polls the latest block until its timestamp reaches `timestamp`. */
async function blockReaches(
  publicClient: Pick<PublicClient, "getBlock">,
  timestamp: bigint,
  { waitMs, pollMs }: BlockWait,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const block = await publicClient.getBlock({ blockTag: "latest" });
      if (block.timestamp >= timestamp) return true;
    } catch {
      // Not readable now: keep polling until the deadline.
    }
    if (Date.now() + pollMs > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
