import { z } from "zod";

export const campaignIdSchema = z.string().min(1);

export const atomicAmountSchema = z
  .string()
  .regex(
    /^\d+$/,
    "Atomic monetary amounts must be non-negative integer strings.",
  );

export type CampaignId = z.infer<typeof campaignIdSchema>;

export { campaignManagerAbi } from "./contracts/campaign-manager-abi.js";
export {
  getSupportedChain,
  SUPPORTED_CHAINS,
  type SupportedChain,
} from "./chains.js";
