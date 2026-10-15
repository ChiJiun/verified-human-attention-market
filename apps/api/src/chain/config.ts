import { FUNCTION_SELECTORS } from "./abi.js";

/**
 * Contract/chain configuration validated at API startup (issue #19).
 * Wrong-chain or missing-address configuration fails fast instead of
 * silently pointing financial flows at the wrong deployment.
 */

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Mirrors packages/shared/src/chains.ts (official sources checked 2026-10-12). */
const OFFICIAL_USDC: Readonly<Record<number, string>> = {
  84532: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
};
const SUPPORTED_CHAIN_IDS = new Set([84532, 31337]);

export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  usdcAddress: string;
  campaignManagerAddress: string;
  /** First block to index (deployment block). */
  deployBlock: bigint;
}

/** Default depth after which a block is treated as final. */
export const DEFAULT_CONFIRMATIONS = 10;

/**
 * INDEXER_CONFIRMATIONS for both the API (links) and the indexer worker
 * (events). Must be a positive integer: 0 would link unconfirmed creations.
 */
export function parseConfirmations(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_CONFIRMATIONS;
  }

  const parsed = Number(value);

  if (
    !/^\d+$/.test(value.trim()) ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1
  ) {
    throw new ChainConfigError([
      `INDEXER_CONFIRMATIONS must be a positive integer, got "${value}"`,
    ]);
  }

  return parsed;
}

export class ChainConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid chain configuration: ${problems.join("; ")}`);
    this.name = "ChainConfigError";
  }
}

const KEYS = [
  "EVM_RPC_URL",
  "USDC_ADDRESS",
  "CAMPAIGN_MANAGER_ADDRESS",
  "CAMPAIGN_MANAGER_DEPLOY_BLOCK",
] as const;

/**
 * Returns null when no on-chain integration is configured at all (local API
 * development). Any partial or inconsistent configuration throws.
 */
export function loadChainConfig(
  env: Record<string, string | undefined>,
): ChainConfig | null {
  const present = KEYS.filter((key) => (env[key] ?? "") !== "");

  if (present.length === 0) {
    return null;
  }

  const problems: string[] = [];

  for (const key of KEYS) {
    if (!present.includes(key)) {
      problems.push(`${key} is required when on-chain integration is enabled`);
    }
  }

  const chainId = Number(env.EVM_CHAIN_ID ?? "");

  if (!SUPPORTED_CHAIN_IDS.has(chainId)) {
    problems.push(
      `EVM_CHAIN_ID must be one of ${[...SUPPORTED_CHAIN_IDS].join(", ")}`,
    );
  }

  const rpcUrl = env.EVM_RPC_URL ?? "";
  if (rpcUrl && !URL.canParse(rpcUrl)) {
    problems.push("EVM_RPC_URL is not a valid URL");
  }

  const usdcAddress = (env.USDC_ADDRESS ?? "").toLowerCase();
  const campaignManagerAddress = (
    env.CAMPAIGN_MANAGER_ADDRESS ?? ""
  ).toLowerCase();

  for (const [key, value] of [
    ["USDC_ADDRESS", usdcAddress],
    ["CAMPAIGN_MANAGER_ADDRESS", campaignManagerAddress],
  ] as const) {
    if (value && !ADDRESS_PATTERN.test(value)) {
      problems.push(`${key} is not an EVM address`);
    }
  }

  const official = OFFICIAL_USDC[chainId];
  if (official && usdcAddress && usdcAddress !== official) {
    problems.push(
      `USDC_ADDRESS does not match the official USDC on chain ${chainId}`,
    );
  }

  const deployBlockRaw = env.CAMPAIGN_MANAGER_DEPLOY_BLOCK ?? "";
  if (deployBlockRaw && !/^\d+$/.test(deployBlockRaw)) {
    problems.push("CAMPAIGN_MANAGER_DEPLOY_BLOCK must be a block number");
  }

  if (problems.length > 0) {
    throw new ChainConfigError(problems);
  }

  return {
    chainId,
    rpcUrl,
    usdcAddress,
    campaignManagerAddress,
    deployBlock: BigInt(deployBlockRaw),
  };
}

async function rpc(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new ChainConfigError([
      `RPC ${method} returned HTTP ${response.status}`,
    ]);
  }

  const body = (await response.json()) as { result?: unknown; error?: unknown };

  if (body.error !== undefined || body.result === undefined) {
    throw new ChainConfigError([`RPC ${method} returned an error`]);
  }

  return body.result;
}

/** Verifies the RPC endpoint is the configured chain and contracts exist. */
export async function verifyChainConnection(
  config: ChainConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const chainIdHex = await rpc(fetchImpl, config.rpcUrl, "eth_chainId", []);

  if (
    typeof chainIdHex !== "string" ||
    Number(BigInt(chainIdHex)) !== config.chainId
  ) {
    throw new ChainConfigError([
      `RPC chain id ${String(chainIdHex)} does not match EVM_CHAIN_ID ${config.chainId}`,
    ]);
  }

  for (const [key, address] of [
    ["CAMPAIGN_MANAGER_ADDRESS", config.campaignManagerAddress],
    ["USDC_ADDRESS", config.usdcAddress],
  ] as const) {
    const code = await rpc(fetchImpl, config.rpcUrl, "eth_getCode", [
      address,
      "latest",
    ]);

    if (typeof code !== "string" || code === "0x" || code === "0x0") {
      throw new ChainConfigError([
        `${key} has no contract code on chain ${config.chainId}`,
      ]);
    }
  }

  // ADR-0011: the API and web app need `campaignIdByDraft`. A contract from
  // before it has code but reverts here, and must be redeployed rather than
  // used with the new createCampaign ABI. Transport and provider errors are
  // reported as such, never as an incompatible contract.
  const probe = await probeCampaignIdByDraft(fetchImpl, config);

  if (probe === "unsupported") {
    throw new ChainConfigError([
      "CAMPAIGN_MANAGER_ADDRESS is a CampaignManager from before ADR-0011 (campaignIdByDraft reverts). Redeploy it (docs/deployment/TESTNET.md) and update the address.",
    ]);
  }
}

async function probeCampaignIdByDraft(
  fetchImpl: typeof fetch,
  config: ChainConfig,
): Promise<"supported" | "unsupported"> {
  const unavailable = (detail: string) =>
    new ChainConfigError([
      `Could not verify CAMPAIGN_MANAGER_ADDRESS: RPC eth_call ${detail}. This is a provider problem, not a contract version problem; retry or use another RPC.`,
    ]);

  let response: Response;
  try {
    response = await fetchImpl(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [
          {
            to: config.campaignManagerAddress,
            data: `${FUNCTION_SELECTORS.campaignIdByDraft}${"0".repeat(64)}${"0".repeat(63)}1`,
          },
          "latest",
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw unavailable(
      `failed (${error instanceof Error ? error.message : "network error"})`,
    );
  }

  if (!response.ok) {
    throw unavailable(`returned HTTP ${response.status}`);
  }

  const body = (await response.json().catch(() => null)) as {
    result?: unknown;
    error?: { code?: unknown; message?: unknown };
  } | null;

  if (body?.error) {
    // Execution reverted: EIP-1474 code 3, or a "revert" message from
    // providers that use another code.
    const message = String(body.error.message ?? "");
    if (body.error.code === 3 || /revert/i.test(message)) {
      return "unsupported";
    }
    throw unavailable(
      `returned error ${String(body.error.code)} ${message}`.trim(),
    );
  }

  if (body?.result === "0x") {
    // No return data at all: the function does not exist.
    return "unsupported";
  }

  if (
    typeof body?.result !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(body.result)
  ) {
    throw unavailable("returned malformed data");
  }

  return "supported";
}
