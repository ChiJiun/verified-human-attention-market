import { campaignManagerAbi } from "@vham/shared/contracts";
import {
  createPublicClient,
  custom,
  encodeErrorResult,
  encodeFunctionData,
  type ContractErrorName,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";

import { ApiError } from "../lib/api";
import {
  claimCall,
  isAlreadyPaid,
  simulateClaim,
  type Authorization,
} from "../lib/claim";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTRACT = "0xcccccccccccccccccccccccccccccccccccccccc";
const AUTH: Authorization = {
  campaignId: "1",
  draftRef: `0x${"11".repeat(32)}`,
  claimant: WALLET,
  amount: "1000000",
  nonce: `0x${"22".repeat(32)}`,
  issuedAt: 1_791_186_300,
  expiresAt: 1_791_187_200,
  signature: `0x${"33".repeat(65)}`,
  contractAddress: CONTRACT,
};
const CALL = claimCall(WALLET, AUTH);

/** A node that answers every eth_call like the contract would. */
function node(revert: ContractErrorName<typeof campaignManagerAbi> | null) {
  const calls: { from?: string; to?: string; data?: Hex }[] = [];
  const publicClient = createPublicClient({
    transport: custom(
      {
        async request({ method, params }) {
          if (method !== "eth_call") throw new Error(`unexpected ${method}`);
          calls.push((params as [(typeof calls)[number]])[0]);
          if (revert === null) return "0x";
          // What geth and anvil answer for a reverted call.
          throw Object.assign(new Error("execution reverted"), {
            code: 3,
            data: encodeErrorResult({
              abi: campaignManagerAbi,
              errorName: revert,
            }),
          });
        },
      },
      // viem retries a revert it cannot classify; one call keeps it exact.
      { retryCount: 0 },
    ),
  });
  return { publicClient, calls };
}

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
      const { publicClient, calls } = node(revert);

      await expect(simulateClaim(publicClient, CALL)).resolves.toBe(
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
    const { publicClient } = node("AuthorizationExpired");

    const failure = simulateClaim(publicClient, CALL);

    await expect(failure).rejects.toThrow(
      "The contract would reject this transaction (AuthorizationExpired), so nothing was sent.",
    );
    await expect(failure).rejects.toSatisfy(
      (error: unknown) => !isAlreadyPaid(error),
    );
  });

  it("lets a claim the contract would pay go to the wallet", async () => {
    const { publicClient } = node(null);

    await expect(simulateClaim(publicClient, CALL)).resolves.toBe("ready");
  });
});
