import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import {
  ChainConfigError,
  loadChainConfig,
  parseConfirmations,
  verifyChainConnection,
} from "../src/chain/config.js";
import { InMemoryChainEventRepository } from "../src/chain/events-repository.js";
import { FakeChain } from "./support/fake-chain.js";

const valid = {
  EVM_CHAIN_ID: "84532",
  EVM_RPC_URL: "https://rpc.example",
  USDC_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  CAMPAIGN_MANAGER_ADDRESS: "0x" + "1".repeat(40),
  CAMPAIGN_MANAGER_DEPLOY_BLOCK: "123",
};

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadChainConfig(env);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ChainConfigError);
    return (error as ChainConfigError).problems;
  }
}

describe("loadChainConfig", () => {
  it("returns null when on-chain integration is not configured", () => {
    expect(loadChainConfig({ EVM_CHAIN_ID: "84532" })).toBeNull();
  });

  it("parses a complete Base Sepolia configuration", () => {
    expect(loadChainConfig(valid)).toEqual({
      chainId: 84532,
      rpcUrl: "https://rpc.example",
      usdcAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      campaignManagerAddress: "0x" + "1".repeat(40),
      deployBlock: 123n,
    });
  });

  it("fails fast on partial configuration", () => {
    expect(
      problemsOf({ ...valid, CAMPAIGN_MANAGER_ADDRESS: undefined }),
    ).toContain(
      "CAMPAIGN_MANAGER_ADDRESS is required when on-chain integration is enabled",
    );
  });

  it("rejects unsupported chains, including Base mainnet", () => {
    expect(problemsOf({ ...valid, EVM_CHAIN_ID: "8453" })[0]).toMatch(
      /EVM_CHAIN_ID must be one of/,
    );
  });

  it("rejects a non-official USDC address on Base Sepolia", () => {
    expect(
      problemsOf({ ...valid, USDC_ADDRESS: "0x" + "2".repeat(40) }),
    ).toContain("USDC_ADDRESS does not match the official USDC on chain 84532");
  });

  it("rejects malformed values", () => {
    const problems = problemsOf({
      ...valid,
      EVM_RPC_URL: "not a url",
      CAMPAIGN_MANAGER_ADDRESS: "0x1234",
      CAMPAIGN_MANAGER_DEPLOY_BLOCK: "-1",
    });

    expect(problems).toHaveLength(3);
  });

  it("allows a mock token address on local anvil", () => {
    expect(
      loadChainConfig({
        ...valid,
        EVM_CHAIN_ID: "31337",
        USDC_ADDRESS: "0x" + "3".repeat(40),
      })?.chainId,
    ).toBe(31337);
  });
});

function rpcStub(results: Record<string, unknown>) {
  return (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(init.body as string) as {
      method: string;
      params: unknown[];
    };
    const key =
      method === "eth_getCode" ? `${method}:${String(params[0])}` : method;
    if (!(key in results)) {
      // Like a reverting eth_call on a contract without the function.
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 3 } }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: results[key] }),
      {
        status: 200,
      },
    );
  }) as unknown as typeof fetch;
}

describe("verifyChainConnection", () => {
  const config = loadChainConfig(valid)!;

  it("accepts the configured chain with deployed contracts", async () => {
    await expect(
      verifyChainConnection(
        config,
        rpcStub({
          eth_chainId: "0x14a34",
          [`eth_getCode:${config.campaignManagerAddress}`]: "0x6080",
          [`eth_getCode:${config.usdcAddress}`]: "0x6080",
          eth_call: `0x${"0".repeat(64)}`,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses a CampaignManager deployed before ADR-0011", async () => {
    // Code exists, but campaignIdByDraft reverts.
    await expect(
      verifyChainConnection(
        config,
        rpcStub({
          eth_chainId: "0x14a34",
          [`eth_getCode:${config.campaignManagerAddress}`]: "0x6080",
          [`eth_getCode:${config.usdcAddress}`]: "0x6080",
        }),
      ),
    ).rejects.toThrow(/before ADR-0011/);
  });

  /** Answers chain id and code; eth_call gets `callResponse`. */
  function providerFailing(callResponse: () => Response) {
    const stub = rpcStub({
      eth_chainId: "0x14a34",
      [`eth_getCode:${config.campaignManagerAddress}`]: "0x6080",
      [`eth_getCode:${config.usdcAddress}`]: "0x6080",
    });
    return (async (url: string, init: RequestInit) => {
      const { method } = JSON.parse(init.body as string) as { method: string };
      return method === "eth_call" ? callResponse() : stub(url, init);
    }) as unknown as typeof fetch;
  }

  it.each([
    ["HTTP 503", () => new Response("unavailable", { status: 503 })],
    [
      "a rate-limit error",
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32005, message: "limit exceeded" },
          }),
          { status: 200 },
        ),
    ],
  ])(
    "reports %s on the version probe as a provider problem, not an old contract",
    async (_label, callResponse) => {
      const result = verifyChainConnection(
        config,
        providerFailing(callResponse),
      );
      await expect(result).rejects.toThrow(/provider problem/);
      await expect(result).rejects.not.toThrow(/before ADR-0011/);
    },
  );

  it("fails when the RPC is a different chain", async () => {
    await expect(
      verifyChainConnection(config, rpcStub({ eth_chainId: "0x2105" })),
    ).rejects.toThrow(/does not match/);
  });

  it("fails when a contract has no code", async () => {
    await expect(
      verifyChainConnection(
        config,
        rpcStub({
          eth_chainId: "0x14a34",
          [`eth_getCode:${config.campaignManagerAddress}`]: "0x",
        }),
      ),
    ).rejects.toThrow(/no contract code/);
  });
});

describe("INDEXER_CONFIRMATIONS (API and worker)", () => {
  it("defaults to 10 and accepts positive integers", () => {
    expect(parseConfirmations(undefined)).toBe(10);
    expect(parseConfirmations("")).toBe(10);
    expect(parseConfirmations("3")).toBe(3);
  });

  it.each(["0", "-1", "abc", "1.5", "1e3", " "])(
    "refuses %j at startup instead of linking unconfirmed creations or failing later",
    (value) => {
      expect(() => parseConfirmations(value)).toThrow(ChainConfigError);
    },
  );

  it.each([0, -1, 1.5, Number.NaN])(
    "buildApp refuses chain.confirmations = %s",
    (confirmations) => {
      const contract = "0x" + "c0".repeat(20);
      expect(() =>
        buildApp({
          chain: {
            rpc: new FakeChain(contract),
            chain: {
              chainId: 84532,
              contractAddress: contract,
              usdcAddress: "0x" + "d0".repeat(20),
            },
            events: new InMemoryChainEventRepository(),
            now: () => new Date(),
            confirmations,
          },
        }),
      ).toThrow(/confirmations must be a positive integer/);
    },
  );
});
