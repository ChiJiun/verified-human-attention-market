import { z } from "zod";

const evmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Invalid EVM address");

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
    contentUrl: z.url(),
    rewardPerCompletion: positiveAtomicAmountSchema,
    maxCompletions: z.number().int().min(1).max(10),
    startAt: dateTimeSchema,
    endAt: dateTimeSchema,
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

    if (durationMs > 24 * 60 * 60 * 1000) {
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

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
