import { createRpSigner, type RpSigner } from "./rp-signature.js";
import {
  HttpWorldIdVerifier,
  LOCAL_DEV_CHAIN_ID,
  LocalSimulatedWorldIdVerifier,
  parseWorldIdAppId,
  parseWorldIdRpId,
  UnconfiguredWorldIdVerifier,
  type WorldIdAppId,
  type WorldIdEnvironment,
  type WorldIdRpId,
  type WorldIdVerifier,
} from "./world-id.js";

export type WorldIdConfig =
  | {
      mode: "live";
      rpId: WorldIdRpId;
      appId: WorldIdAppId;
      signer: RpSigner;
      environment: WorldIdEnvironment;
    }
  | { mode: "simulated" };

export class WorldIdConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid World ID configuration: ${problems.join("; ")}`);
    this.name = "WorldIdConfigError";
  }
}

const LIVE_KEYS = [
  "WORLD_ID_RP_ID",
  "RP_SIGNING_KEY",
  "WORLD_ID_APP_ID",
] as const;

export function loadWorldIdConfig(
  env: Record<string, string | undefined>,
  chainId: number,
): { config: WorldIdConfig | null; warnings: string[] } {
  const mode = env.WORLD_ID_MODE || "live";
  const environment = env.WORLD_ID_ENVIRONMENT || "production";

  if (mode !== "live" && mode !== "simulated") {
    throw new WorldIdConfigError(["WORLD_ID_MODE must be live or simulated"]);
  }

  if (mode === "simulated") {
    if (chainId !== LOCAL_DEV_CHAIN_ID) {
      throw new WorldIdConfigError([
        `WORLD_ID_MODE=simulated is only allowed on the local chain ${LOCAL_DEV_CHAIN_ID}`,
      ]);
    }

    return {
      config: { mode: "simulated" },
      warnings: ["WORLD_ID_MODE=simulated: local anvil demo only"],
    };
  }

  const present = LIVE_KEYS.filter((key) => env[key]);

  if (present.length === 0) {
    return {
      config: null,
      warnings: [
        "World ID is disabled: set WORLD_ID_RP_ID, RP_SIGNING_KEY and WORLD_ID_APP_ID",
      ],
    };
  }

  const problems = LIVE_KEYS.filter((key) => !env[key]).map(
    (key) => `${key} is required when World ID is live`,
  );
  const rpId = parseWorldIdRpId(env.WORLD_ID_RP_ID ?? "");
  const appId = parseWorldIdAppId(env.WORLD_ID_APP_ID ?? "");
  const key = env.RP_SIGNING_KEY ?? "";

  if (env.WORLD_ID_RP_ID && rpId === null) {
    problems.push("WORLD_ID_RP_ID must be rp_ followed by 1 to 16 hex digits");
  }

  if (key && !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
    problems.push("RP_SIGNING_KEY must be 32 bytes of hex");
  }

  if (env.WORLD_ID_APP_ID && appId === null) {
    problems.push("WORLD_ID_APP_ID must start with app_");
  }

  if (environment !== "production" && environment !== "staging") {
    problems.push("WORLD_ID_ENVIRONMENT must be production or staging");
  }

  if (
    problems.length > 0 ||
    rpId === null ||
    appId === null ||
    (environment !== "production" && environment !== "staging")
  ) {
    throw new WorldIdConfigError(problems);
  }

  return {
    config: {
      mode: "live",
      rpId,
      appId,
      signer: createRpSigner(key),
      environment,
    },
    warnings: [],
  };
}

export function worldIdVerifierFor(
  config: WorldIdConfig | null,
  chainId: number,
): WorldIdVerifier {
  if (config === null) {
    return new UnconfiguredWorldIdVerifier();
  }

  return config.mode === "live"
    ? new HttpWorldIdVerifier({
        rpId: config.rpId,
        environment: config.environment,
      })
    : new LocalSimulatedWorldIdVerifier(chainId);
}
