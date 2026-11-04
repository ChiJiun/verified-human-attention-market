import { campaignManagerAbi } from "@vham/shared/contracts";
import {
  isAddressEqual,
  parseEventLogs,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";

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
  /** The chain of the signature's EIP-712 domain and of `contractAddress`. */
  chainId: number;
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

/**
 * The `claim` transaction for `auth`, sent from `account` on `expected`, the
 * chain this site is built for (the one its network check, wallet clients
 * and `writeContract` use). An authorization the API signed for another
 * chain throws here, before anything is simulated or sent: its contract
 * address means nothing on `expected`, where an address without code would
 * simulate and "confirm" a claim that pays nothing. That is a deployment
 * whose web app and API are set up for different chains, so it is refused
 * rather than followed.
 */
export function claimCall(
  account: Address,
  auth: Authorization,
  expected: { id: number; name: string },
) {
  if (auth.chainId !== expected.id) {
    throw new Error(
      `This claim was authorized on chain ${String(auth.chainId)}, but this site is set up for ${expected.name} (${expected.id}), so nothing was sent. The site's network configuration needs fixing.`,
    );
  }
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

export type ClaimCall = ReturnType<typeof claimCall>;

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
 * The contract address must hold code first: an `eth_call` to an address
 * without code returns empty data, which reads as a successful simulation,
 * and the transaction would then be mined "successfully" while paying
 * nothing (a stale or broken deployment in the API's configuration).
 *
 * The API signs with `issuedAt` = now, and the simulation runs on the latest
 * block, usually a second or two older, where the contract answers
 * AuthorizationNotYetValid. That revert waits (bounded) for a block at or
 * after `issuedAt` and simulates once more.
 */
export async function simulateClaim(
  publicClient: Pick<PublicClient, "simulateContract" | "getBlock" | "getCode">,
  call: ClaimCall,
  blockWait: BlockWait = BLOCK_WAIT,
): Promise<"ready" | "already-paid"> {
  await assertContractCode(publicClient, call.address);
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

/** Throws, with nothing sent, unless `address` holds code on the wallet's chain. */
async function assertContractCode(
  publicClient: Pick<PublicClient, "getCode">,
  address: Address,
): Promise<void> {
  let code: Hex | undefined;
  try {
    code = await publicClient.getCode({ address });
  } catch (caught) {
    throw new Error(describeSimulationFailure(caught), { cause: caught });
  }
  // viem returns undefined for "0x"; both mean no contract.
  if (code === undefined || code === "0x") {
    throw new Error(
      `There is no contract at ${address} on your wallet's network, so nothing was sent. The site's contract configuration needs fixing.`,
    );
  }
}

/**
 * Whether a claim transaction's receipt `logs` hold the RewardClaimed event
 * this claim emits: from the claim's contract, for its campaign, claimant,
 * amount and nonce. A receipt can say "success" without it, for example a
 * call to an address that holds no code, or to a contract that is not
 * CampaignManager; only the event shows that the reward was paid.
 */
export function claimEventIn(logs: readonly Log[], call: ClaimCall): boolean {
  const [authorization] = call.args;
  return parseEventLogs({
    abi: campaignManagerAbi,
    eventName: "RewardClaimed",
    logs: [...logs],
  }).some(
    ({ address, args }) =>
      isAddressEqual(address, call.address) &&
      args.campaignId === authorization.campaignId &&
      isAddressEqual(args.claimant, authorization.claimant) &&
      args.amount === authorization.amount &&
      args.nonce.toLowerCase() === authorization.nonce.toLowerCase(),
  );
}

export type ClaimTxOutcome =
  /** Mined with this claim's RewardClaimed event. */
  | { kind: "paid"; hash: Hash }
  /** Mined successfully, but the receipt has no RewardClaimed for this claim. */
  | { kind: "no-claim-event"; hash: Hash }
  | { kind: "reverted"; hash: Hash }
  /** No receipt yet: the transaction may still be mined. Never resend. */
  | { kind: "pending"; hash: Hash };

/** Judges a mined claim transaction by its receipt (claimEventIn). */
export function claimReceiptOutcome(
  receipt: Pick<TransactionReceipt, "status" | "logs">,
  call: ClaimCall,
  hash: Hash,
): Exclude<ClaimTxOutcome, { kind: "pending" }> {
  if (receipt.status !== "success") return { kind: "reverted", hash };
  return claimEventIn(receipt.logs, call)
    ? { kind: "paid", hash }
    : { kind: "no-claim-event", hash };
}

/**
 * Waits for the claim's receipt like waitForTx (lib/wallet.ts), and reports
 * it paid only when the receipt carries this claim's RewardClaimed event.
 */
export async function waitForClaim(
  publicClient: Pick<PublicClient, "waitForTransactionReceipt">,
  call: ClaimCall,
  hash: Hash,
  timeoutMs = 120_000,
): Promise<ClaimTxOutcome> {
  let receipt: TransactionReceipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: timeoutMs,
    });
  } catch {
    return { kind: "pending", hash };
  }
  return claimReceiptOutcome(receipt, call, hash);
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
