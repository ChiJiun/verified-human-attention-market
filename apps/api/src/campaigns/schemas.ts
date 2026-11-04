import { z } from "zod";
import { EVM_ADDRESS } from "../http/validation.js";

import { httpsUrlSchema, missionInputSchema } from "../missions/schemas.js";
import { DAY_MS } from "../time.js";

const evmAddressSchema = z.string().regex(EVM_ADDRESS, "Invalid EVM address");

const positiveAtomicAmountSchema = z
  .string()
  .regex(/^\d+$/, "Reward must be an integer atomic-unit string")
  .refine(
    (value) => (/^\d+$/.test(value) ? BigInt(value) > 0n : false),
    "Reward must be greater than zero",
  );

const dateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

export const createCampaignSchema = z
  .object({
    advertiser: evmAddressSchema,
    contentUrl: httpsUrlSchema,
    rewardPerCompletion: positiveAtomicAmountSchema,
    maxCompletions: z.number().int().min(1).max(10),
    startAt: dateTimeSchema,
    endAt: dateTimeSchema,
    mission: missionInputSchema,
  })
  .superRefine((value, context) => {
    const durationMs = value.endAt.getTime() - value.startAt.getTime();

    if (durationMs < 15 * 60 * 1000) {
      context.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "Campaign must last at least 15 minutes",
      });
    }

    if (durationMs > DAY_MS) {
      context.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "Campaign cannot exceed 24 hours",
      });
    }

    if (value.endAt <= value.startAt) {
      context.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "endAt must be after startAt",
      });
    }
  });
