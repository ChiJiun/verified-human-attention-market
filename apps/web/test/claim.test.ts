import { campaignManagerAbi } from "@vham/shared/contracts";
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  toHex,
  WaitForTransactionReceiptTimeoutError,
  type ContractErrorName,
  type Hash,
  type Hex,
  type Log,
} from "viem";
import { describe, expect, it } from "vitest";

import { ApiError } from "../lib/api";
import {
  assertClaimChain,
  claimCall,
  claimEventIn,
  claimReceiptOutcome,
  isAlreadyPaid,
  simulateClaim,
  waitForClaim,
  type Authorization,
} from "../lib/claim";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTRACT = "0xcccccccccccccccccccccccccccccccccccccccc";
const ISSUED_AT = 1_791_186_300;
const BASE_SEPOLIA = { id: 84532, name: "Base Sepolia" };
const AUTH: Authorization = {
  campaignId: "1",
  draftRef: `0x${"11".repeat(32)}`,
  claimant: WALLET,
  amount: "1000000",
  nonce: `0x${"22".repeat(32)}`,
  issuedAt: ISSUED_AT,
  expiresAt: ISSUED_AT + 900,
  signature: `0x${"33".repeat(65)}`,
  chainId: BASE_SEPOLIA.id,
  contractAddress: CONTRACT,
};
const CALL = claimCall(WALLET, AUTH, BASE_SEPOLIA);
/** Short enough for a test; the page waits up to 15 s. */
const FAST = { waitMs: 200, pollMs: 1 };

type Revert = ContractErrorName<typeof campaignManagerAbi>;

/**
 * A node whose latest block starts at `blockTime` and moves `tick` seconds
 * per block read. eth_call answers like the contract would at that block:
 * `revert(blockTime)` names the error, or null for success. eth_getCode
 * answers `code` for CONTRACT ("0x": no contract there; an Error: the
 * lookup fails), and "0x" for any other address.
 */
function node(
  revert: (blockTime: number) => Revert | null,
  {
    blockTime = ISSUED_AT,
    tick = 0,
    code = "0x6080" as Hex | Error,
  }: { blockTime?: number; tick?: number; code?: Hex | Error } = {},
) {
  const calls: { from?: string; to?: string; data?: Hex }[] = [];
  const codeReads: string[] = [];
  let blockReads = 0;
  const publicClient = createPublicClient({
    transport: custom(
      {
        async request({ method, params }) {
          if (method === "eth_getCode") {
            const [address] = params as [string];
            codeReads.push(address);
            if (address.toLowerCase() !== CONTRACT) return "0x";
            if (code instanceof Error) throw code;
            return code;
          }
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
  return { publicClient, calls, codeReads, blockReads: () => blockReads };
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

describe("the authorization's chain", () => {
  it.each([
    // The API runs on anvil while the site was built for Base Sepolia.
    ["another supported chain", 31337],
    // A response that does not say which chain it was signed for.
    ["no chain at all", undefined],
  ])(
    "refuses an authorization for %s before anything is simulated or sent",
    async (_case, chainId) => {
      const auth = { ...AUTH, chainId } as Authorization;
      // A contract address with no code on the wallet's chain: the
      // simulation would pass and the claim would "confirm" paying nothing.
      const { publicClient, calls } = node(() => null);
      const sent: unknown[] = [];

      const attempt = async () => {
        const call = claimCall(WALLET, auth, BASE_SEPOLIA);
        await simulateClaim(publicClient, call, FAST);
        sent.push(call);
      };

      await expect(attempt()).rejects.toThrow(
        `This claim was authorized on chain ${String(chainId)}, but this site is set up for Base Sepolia (84532), so nothing was sent.`,
      );
      expect(calls).toEqual([]);
      expect(sent).toEqual([]);
    },
  );
});

describe("the claim's contract (#110 review)", () => {
  it("refuses an address without code before anything is simulated", async () => {
    // A stale or broken deployment: eth_call to an address without code
    // returns empty data, which would read as a successful simulation.
    const { publicClient, calls, codeReads } = node(() => null, {
      code: "0x",
    });

    await expect(simulateClaim(publicClient, CALL, FAST)).rejects.toThrow(
      `There is no contract at ${CONTRACT} on your wallet's network, so nothing was sent.`,
    );
    expect(codeReads).toEqual([CONTRACT]);
    expect(calls).toEqual([]);
  });

  it("reports a code lookup that fails as not sent", async () => {
    const { publicClient, calls } = node(() => null, {
      code: new Error("rpc down"),
    });

    await expect(simulateClaim(publicClient, CALL, FAST)).rejects.toThrow(
      "Nothing was sent.",
    );
    expect(calls).toEqual([]);
  });

  it("checks the claim's own contract address, once", async () => {
    const { publicClient, codeReads } = node(notYetValidBefore(ISSUED_AT), {
      blockTime: ISSUED_AT - 1,
      tick: 1,
    });

    await expect(simulateClaim(publicClient, CALL, FAST)).resolves.toBe(
      "ready",
    );
    expect(codeReads).toEqual([CONTRACT]);
  });
});

const TX = `0x${"44".repeat(32)}` as Hash;
const OTHER = "0xdddddddddddddddddddddddddddddddddddddddd";

/** A log of a mined transaction, as viem formats a receipt's logs. */
type MinedLog = Log<bigint, number, false>;

/** The RewardClaimed log CampaignManager emits for AUTH, as viem formats it. */
function rewardClaimed(
  overrides: {
    address?: Hex;
    campaignId?: bigint;
    claimant?: Hex;
    amount?: bigint;
    nonce?: Hex;
  } = {},
): MinedLog {
  const {
    address = CONTRACT,
    campaignId = 1n,
    claimant = WALLET,
    amount = 1_000_000n,
    nonce = AUTH.nonce,
  } = overrides;
  return {
    address,
    topics: encodeEventTopics({
      abi: campaignManagerAbi,
      eventName: "RewardClaimed",
      args: { campaignId, claimant },
    }) as Log["topics"],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }],
      [amount, nonce],
    ),
    blockHash: `0x${"55".repeat(32)}`,
    blockNumber: 10n,
    logIndex: 0,
    transactionHash: TX,
    transactionIndex: 0,
    removed: false,
  };
}

/** Another event of the same contract in the same receipt. */
const funded: MinedLog = {
  ...rewardClaimed(),
  topics: encodeEventTopics({
    abi: campaignManagerAbi,
    eventName: "CampaignFunded",
    args: { campaignId: 1n },
  }) as Log["topics"],
  data: encodeAbiParameters([{ type: "uint256" }], [1_000_000n]),
};

/** A receipt of TX (or of `transactionHash`, a replacement) as viem returns it. */
function receipt(
  status: "success" | "reverted",
  logs: MinedLog[],
  transactionHash: Hash = TX,
) {
  return { status, logs, transactionHash };
}

describe("the claim's receipt (#110 review)", () => {
  it("is paid with this claim's RewardClaimed event", () => {
    expect(
      claimReceiptOutcome(
        receipt("success", [funded, rewardClaimed()]),
        CALL,
        TX,
      ),
    ).toEqual({ kind: "paid", hash: TX });
    // A checksummed address in the log is the same contract.
    expect(
      claimEventIn([rewardClaimed({ address: getAddress(CONTRACT) })], CALL),
    ).toBe(true);
  });

  it("is not paid when a successful receipt has no event at all", () => {
    // What a claim sent to an address without code gets: success, no logs.
    expect(claimReceiptOutcome(receipt("success", []), CALL, TX)).toEqual({
      kind: "no-claim-event",
      hash: TX,
      receiptHash: TX,
    });
    expect(claimReceiptOutcome(receipt("success", [funded]), CALL, TX)).toEqual(
      { kind: "no-claim-event", hash: TX, receiptHash: TX },
    );
  });

  it("names the transaction that was mined in the claim's place (#115 review)", () => {
    // A cancel in the wallet: viem returns the replacement's receipt, a
    // transfer to itself with no logs.
    const cancel = `0x${"77".repeat(32)}` as Hash;
    expect(
      claimReceiptOutcome(receipt("success", [], cancel), CALL, TX),
    ).toEqual({ kind: "no-claim-event", hash: TX, receiptHash: cancel });
  });

  it.each([
    ["another contract", { address: OTHER }],
    ["another claimant", { claimant: OTHER }],
    ["another campaign", { campaignId: 2n }],
    ["another amount", { amount: 2_000_000n }],
    ["another nonce", { nonce: `0x${"66".repeat(32)}` }],
  ] as const)(
    "is not paid when the RewardClaimed event is for %s",
    (_case, overrides) => {
      expect(
        claimReceiptOutcome(
          receipt("success", [rewardClaimed(overrides)]),
          CALL,
          TX,
        ),
      ).toEqual({ kind: "no-claim-event", hash: TX, receiptHash: TX });
    },
  );

  it("reports a reverted receipt as reverted, whatever its logs", () => {
    expect(
      claimReceiptOutcome(receipt("reverted", [rewardClaimed()]), CALL, TX),
    ).toEqual({ kind: "reverted", hash: TX });
  });
});

/** A node that has mined TX with `logs` (RPC form) and `status`. */
function minedNode(logs: MinedLog[], status: "0x1" | "0x0" = "0x1") {
  return createPublicClient({
    transport: custom(
      {
        async request({ method }) {
          if (method !== "eth_getTransactionReceipt") {
            throw new Error(`unexpected ${method}`);
          }
          return {
            blockHash: `0x${"55".repeat(32)}`,
            blockNumber: "0xa",
            contractAddress: null,
            cumulativeGasUsed: "0x5208",
            effectiveGasPrice: "0x1",
            from: WALLET,
            gasUsed: "0x5208",
            logs: logs.map((log) => ({
              ...log,
              blockNumber: "0xa",
              logIndex: "0x0",
              transactionIndex: "0x0",
            })),
            logsBloom: `0x${"00".repeat(256)}`,
            status,
            to: CONTRACT,
            transactionHash: TX,
            transactionIndex: "0x0",
            type: "0x2",
          };
        },
      },
      { retryCount: 0 },
    ),
  });
}

describe("waiting for the claim (#110 review)", () => {
  it("reports paid only when the mined receipt carries the event", async () => {
    await expect(
      waitForClaim(minedNode([rewardClaimed()]), CALL, TX, 1_000),
    ).resolves.toEqual({ kind: "paid", hash: TX });
    await expect(
      waitForClaim(
        minedNode([rewardClaimed({ address: OTHER })]),
        CALL,
        TX,
        1_000,
      ),
    ).resolves.toEqual({ kind: "no-claim-event", hash: TX, receiptHash: TX });
    await expect(
      waitForClaim(minedNode([], "0x0"), CALL, TX, 1_000),
    ).resolves.toEqual({ kind: "reverted", hash: TX });
  });

  it("leaves a claim without a receipt pending, never failed", async () => {
    const publicClient = {
      waitForTransactionReceipt: async () => {
        throw new WaitForTransactionReceiptTimeoutError({ hash: TX });
      },
    };

    await expect(waitForClaim(publicClient, CALL, TX)).resolves.toEqual({
      kind: "pending",
      hash: TX,
    });
  });
});
