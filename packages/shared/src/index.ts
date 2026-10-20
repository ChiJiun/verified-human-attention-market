import { z } from "zod";

import {
  isWorldIdSignal,
  isWorldIdSignalSalt,
  type WorldIdSignal,
  type WorldIdSignalSalt,
} from "./world-id.js";

export const campaignIdSchema = z.string().min(1);

export const atomicAmountSchema = z
  .string()
  .regex(
    /^\d+$/,
    "Atomic monetary amounts must be non-negative integer strings.",
  );

export type CampaignId = z.infer<typeof campaignIdSchema>;

export const worldIdSignalSaltSchema = z.custom<WorldIdSignalSalt>(
  isWorldIdSignalSalt,
  "signalSalt must be 32 bytes as 0x hex",
);

export const worldIdSignalSchema = z.custom<WorldIdSignal>(
  isWorldIdSignal,
  "signal must be 32 bytes as 0x hex",
);

export { campaignManagerAbi } from "./contracts/campaign-manager-abi.js";
export {
  getSupportedChain,
  SUPPORTED_CHAINS,
  type SupportedChain,
} from "./chains.js";
