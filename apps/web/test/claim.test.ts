import { campaignManagerAbi } from "@vham/shared/contracts";
import {
  createPublicClient,
  custom,
  encodeErrorResult,
  encodeFunctionData,
  toHex,
  type ContractErrorName,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";

import { ApiError } from "../lib/api";
import {
  assertClaimChain,
  claimCall,
  isAlreadyPaid,
  simulateClaim,
  type Authorization,
} from "../lib/claim";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTRACT = "0xcccccccccccccccccccccccccccccccccccccccc";
const ISSUED_AT = 1_791_186_300;
const AUTH: Authorization = {
  campaignId: "1",
  draftRef: `0x${"11".repeat(32)}`,
  claimant: WALLET,
  amount: "1000000",
  nonce: `0x${"22".repeat(32)}`,
  issuedAt: ISSUED_AT,
  expiresAt: ISSUED_AT + 900,
  signature: `0x${"33".repeat(65)}`,
  contractAddress: CONTRACT,
};
const CALL = claimCall(WALLET, AUTH);
/** Short enough for a test; the page waits up to 15 s. */
const FAST = { waitMs: 200, pollMs: 1 };

type Revert = ContractErrorName<typeof campaignManagerAbi>;

/**
 * A node whose latest block starts at `blockTime` and moves `tick` seconds
 * per block read. eth_call answers like the contract would at that block:
 * `revert(blockTime)` names the error, or null for success.
 */
function node(
  revert: (blockTime: number) => Revert | null,
  { blockTime = ISSUED_AT, tick = 0 } = {},
) {
  const calls: { from?: string; to?: string; data?: Hex }[] = [];
  let blockReads = 0;
  const publicClient = createPublicClient({
    transport: custom(
      {
        async request({ method, params }) {
          if (method === "eth_getBlockByNumber") {
            blockReads += 1;
            blockTime += tick;
            return {
              number: toHex(blockReads),
              hash: `0x${blockReads.toString(16).padStart(64, "0")}`,
              timestamp: toHex(blockTime),
            };
          }
          if (method !== "eth_call") throw new Error(`unexpected ${method}`);
          calls.push((params as [(typeof calls)[number]])[0]);
          const errorName = revert(blockTime);
          if (errorName === null) return "0x";
          // What geth and anvil answer for a reverted call.
          throw Object.assign(new Error("execution reverted"), {
            code: 3,
            data: encodeErrorResult({ abi: campaignManagerAbi, errorName }),
          });
        },
      },
      // viem retries a revert it cannot classify; one call keeps it exact.
      { retryCount: 0 },
    ),
  });
  return { publicClient, calls, blockReads: () => blockReads };
}

/** The contract's issuedAt check against the block the call runs on. */
const notYetValidBefore = (issuedAt: number) => (blockTime: number) =>
  issuedAt > blockTime ? "AuthorizationNotYetValid" : null;

describe("already paid (#82)", () => {
  it("treats only the API's ALREADY_CLAIMED answer as paid", () => {
    expect(isAlreadyPaid(new ApiError(409, "ALREADY_CLAIMED"))).toBe(true);
    expect(isAlreadyPaid(new ApiError(409, "ALREADY_COMPLETED"))).toBe(false);
    expect(isAlreadyPaid(new ApiError(409, "CAMPAIGN_CAP_REACHED"))).toBe(
      false,
    );
    // Never inferred from a message.
    expect(
      isAlreadyPaid(new Error("This reward was already paid to your wallet.")),
    ).toBe(false);
  });

  it.each(["NonceAlreadyUsed", "WalletAlreadyClaimed"] as const)(
    "reports a claim that reverts with %s as already paid",
    async (revert) => {
      const { publicClient, calls } = node(() => revert);

      await expect(simulateClaim(publicClient, CALL, FAST)).resolves.toBe(
        "already-paid",
      );
      expect(calls).toEqual([
        {
          from: WALLET,
          to: CONTRACT,
          data: encodeFunctionData({
            abi: campaignManagerAbi,
            functionName: "claim",
            args: CALL.args,
          }),
        },
      ]);
    },
  );

  it("throws any other revert with its name, as not sent", async () => {
    const { publicClient } = node(() => "AuthorizationExpired");

    const failure = simulateClaim(publicClient, CALL, FAST);

    await expect(failure).rejects.toThrow(
      "The contract would reject this transaction (AuthorizationExpired), so nothing was sent.",
    );
    await expect(failure).rejects.toSatisfy(
      (error: unknown) => !isAlreadyPaid(error),
    );
  });

  it("lets a claim the contract would pay go to the wallet", async () => {
    const { publicClient, blockReads } = node(() => null);

    await expect(simulateClaim(publicClient, CALL, FAST)).resolves.toBe(
      "ready",
    );
    expect(blockReads()).toBe(0);
  });
});

describe("a just-signed authorization (#82 review)", () => {
  it("waits for a block at its issuedAt, then simulates again", async () => {
    // The latest block is 2 s behind the API's clock and moves 1 s per read.
    const { publicClient, calls, blockReads } = node(
      notYetValidBefore(ISSUED_AT),
      { blockTime: ISSUED_AT - 2, tick: 1 },
    );

    await expect(simulateClaim(publicClient, CALL, FAST)).resolves.toBe(
      "ready",
    );
    expect(blockReads()).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("gives up after the bounded wait and names the revert", async () => {
    const { publicClient, calls, blockReads } = node(
      notYetValidBefore(ISSUED_AT),
      { blockTime: ISSUED_AT - 60, tick: 0 },
    );

    await expect(
      simulateClaim(publicClient, CALL, { waitMs: 20, pollMs: 5 }),
    ).rejects.toThrow(
      "The contract would reject this transaction (AuthorizationNotYetValid), so nothing was sent.",
    );
    expect(calls).toHaveLength(1);
    expect(blockReads()).toBeGreaterThan(1);
  });

  it("simulates again only once", async () => {
    // The block reached issuedAt, yet the node still refuses (a lagging
    // replica, say): the second refusal is shown, not waited on again.
    const { publicClient, calls } = node(() => "AuthorizationNotYetValid", {
      blockTime: ISSUED_AT,
    });

    await expect(simulateClaim(publicClient, CALL, FAST)).rejects.toThrow(
      "(AuthorizationNotYetValid)",
    );
    expect(calls).toHaveLength(2);
  });
});

describe("the wallet's chain (#82 review)", () => {
  const baseSepolia = { id: 84532, name: "Base Sepolia" };

  it("refuses to simulate or send on another chain", async () => {
    await expect(
      assertClaimChain({ getChainId: async () => 1 }, baseSepolia),
    ).rejects.toThrow(
      "Switch your wallet to Base Sepolia, then press Claim USDC again. Nothing was sent.",
    );
    await expect(
      assertClaimChain({ getChainId: async () => 84532 }, baseSepolia),
    ).resolves.toBeUndefined();
  });
});
