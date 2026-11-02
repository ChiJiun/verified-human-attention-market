import {
  ChainMismatchError,
  ContractFunctionExecutionError,
  HttpRequestError,
  TransactionExecutionError,
  UserRejectedRequestError,
} from "viem";
import { baseSepolia, mainnet } from "viem/chains";
import { describe, expect, it } from "vitest";

import { isUserRejection, nothingWasSent } from "../lib/wallet-errors";

/** Wraps `cause` the way writeContract reports a failed send. */
function asWriteContractError(cause: Error) {
  return new ContractFunctionExecutionError(
    new TransactionExecutionError(cause as never, {} as never),
    { abi: [], functionName: "createCampaign" },
  );
}

describe("wallet errors", () => {
  it("recognizes a rejection in the wallet, however deeply wrapped", () => {
    const rejected = asWriteContractError(
      new UserRejectedRequestError(new Error("User denied")),
    );

    expect(isUserRejection(rejected)).toBe(true);
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(nothingWasSent(rejected)).toBe(true);
  });

  it("treats viem's chain check, raised before broadcasting, as nothing sent", () => {
    const mismatch = asWriteContractError(
      new ChainMismatchError({
        chain: baseSepolia,
        currentChainId: mainnet.id,
      }),
    );

    expect(isUserRejection(mismatch)).toBe(false);
    expect(nothingWasSent(mismatch)).toBe(true);
  });

  it("does not claim nothing was sent for a transport failure", () => {
    // The node may have accepted the transaction before the response was lost.
    const lost = asWriteContractError(
      new HttpRequestError({ url: "https://rpc.example", status: 504 }),
    );

    expect(nothingWasSent(lost)).toBe(false);
    expect(nothingWasSent(new Error("timeout"))).toBe(false);
    expect(nothingWasSent(null)).toBe(false);
  });
});
