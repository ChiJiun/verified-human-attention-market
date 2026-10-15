import { describe, expect, it } from "vitest";

import {
  ChainConfigError,
  loadChainConfig,
  verifyChainConnection,
} from "../src/chain/config.js";

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
