import { campaignManagerAbi } from "@vham/shared/contracts";
import { toEventSelector, toFunctionSelector } from "viem";

/**
 * CampaignManager event topics / selectors and a strict log decoder.
 *
 * Topics and selectors are derived at load time from the canonical ABI that
 * `forge build` exports to @vham/shared (#19), the same interface the web
 * app uses, so API, web and contract cannot diverge. Every event argument is
 * a static 32-byte word, so the decoder itself stays a small, strict word
 * parser (it rejects dirty address padding and wrong shapes).
 */

type AbiEntry = (typeof campaignManagerAbi)[number];

function canonical(
  type: "event" | "function",
  name: string,
): Extract<AbiEntry, { type: "event" | "function" }> {
  const entry = campaignManagerAbi.find(
    (item) => item.type === type && "name" in item && item.name === name,
  );

  if (!entry || (entry.type !== "event" && entry.type !== "function")) {
    throw new Error(`CampaignManager ABI has no ${type} ${name}`);
  }

  return entry;
}

const EVENT_NAMES = [
  "CampaignCreated",
  "CampaignFunded",
  "RewardClaimed",
  "CampaignClosed",
  "CampaignRefunded",
  "CampaignCancelled",
  "SignerUpdated",
  "PausedStateChanged",
  "OwnershipTransferred",
] as const;

const FUNCTION_NAMES = [
  "campaigns",
  "campaignIdByDraft",
  "createCampaign",
  "fundCampaign",
] as const;

export const EVENT_TOPICS = Object.fromEntries(
  EVENT_NAMES.map((name) => [
    name,
    toEventSelector(canonical("event", name) as never),
  ]),
) as Record<(typeof EVENT_NAMES)[number], `0x${string}`>;

export const FUNCTION_SELECTORS = Object.fromEntries(
  FUNCTION_NAMES.map((name) => [
    name,
    toFunctionSelector(canonical("function", name) as never),
  ]),
) as Record<(typeof FUNCTION_NAMES)[number], `0x${string}`>;

export type CampaignManagerEvent =
  | {
      name: "CampaignCreated";
      campaignId: string;
      advertiser: string;
      /** Off-chain draft reference (ADR-0011), lowercase 0x hex. */
      draftRef: string;
    }
  | { name: "CampaignFunded"; campaignId: string; amount: string }
  | {
      name: "RewardClaimed";
      campaignId: string;
      claimant: string;
      amount: string;
      nonce: string;
    }
  | { name: "CampaignClosed"; campaignId: string }
  | { name: "CampaignRefunded"; campaignId: string; amount: string }
  | { name: "CampaignCancelled"; campaignId: string }
  | { name: "SignerUpdated"; previousSigner: string; newSigner: string }
  | { name: "OwnershipTransferred"; previousOwner: string; newOwner: string }
  | { name: "PausedStateChanged"; paused: boolean };

const WORD = /^0x[0-9a-f]{64}$/;

function words(data: string): string[] | null {
  if (!/^0x([0-9a-f]{64})*$/.test(data)) {
    return null;
  }

  const body = data.slice(2);
  const result: string[] = [];

  for (let offset = 0; offset < body.length; offset += 64) {
    result.push(`0x${body.slice(offset, offset + 64)}`);
  }

  return result;
}

const uint = (word: string) => BigInt(word).toString(10);

function address(word: string): string | null {
  // Upper 12 bytes of an ABI-encoded address must be zero.
  return /^0x0{24}[0-9a-f]{40}$/.test(word) ? `0x${word.slice(26)}` : null;
}

/**
 * Decodes a CampaignManager log. Returns null for unknown or malformed logs
 * (wrong topic count, wrong data length, dirty address padding).
 */
export function decodeCampaignManagerLog(log: {
  topics: string[];
  data: string;
}): CampaignManagerEvent | null {
  const topics = log.topics.map((topic) => topic.toLowerCase());
  const [topic0, ...indexed] = topics;

  if (!topic0 || indexed.some((topic) => !WORD.test(topic))) {
    return null;
  }

  const data = words(log.data.toLowerCase());

  if (!data) {
    return null;
  }

  const shape = (indexedCount: number, dataCount: number) =>
    indexed.length === indexedCount && data.length === dataCount;

  switch (topic0) {
    case EVENT_TOPICS.CampaignCreated: {
      const advertiser = shape(3, 0) ? address(indexed[1]!) : null;
      return advertiser
        ? {
            name: "CampaignCreated",
            campaignId: uint(indexed[0]!),
            advertiser,
            draftRef: indexed[2]!,
          }
        : null;
    }
    case EVENT_TOPICS.CampaignFunded:
      return shape(1, 1)
        ? {
            name: "CampaignFunded",
            campaignId: uint(indexed[0]!),
            amount: uint(data[0]!),
          }
        : null;
    case EVENT_TOPICS.RewardClaimed: {
      const claimant = shape(2, 2) ? address(indexed[1]!) : null;
      return claimant
        ? {
            name: "RewardClaimed",
            campaignId: uint(indexed[0]!),
            claimant,
            amount: uint(data[0]!),
            nonce: data[1]!,
          }
        : null;
    }
    case EVENT_TOPICS.CampaignClosed:
      return shape(1, 0)
        ? { name: "CampaignClosed", campaignId: uint(indexed[0]!) }
        : null;
    case EVENT_TOPICS.CampaignRefunded:
      return shape(1, 1)
        ? {
            name: "CampaignRefunded",
            campaignId: uint(indexed[0]!),
            amount: uint(data[0]!),
          }
        : null;
    case EVENT_TOPICS.CampaignCancelled:
      return shape(1, 0)
        ? { name: "CampaignCancelled", campaignId: uint(indexed[0]!) }
        : null;
    case EVENT_TOPICS.SignerUpdated: {
      const previousSigner = shape(2, 0) ? address(indexed[0]!) : null;
      const newSigner = previousSigner ? address(indexed[1]!) : null;
      return previousSigner && newSigner
        ? { name: "SignerUpdated", previousSigner, newSigner }
        : null;
    }
    case EVENT_TOPICS.OwnershipTransferred: {
      const previousOwner = shape(2, 0) ? address(indexed[0]!) : null;
      const newOwner = previousOwner ? address(indexed[1]!) : null;
      return previousOwner && newOwner
        ? { name: "OwnershipTransferred", previousOwner, newOwner }
        : null;
    }
    case EVENT_TOPICS.PausedStateChanged: {
      if (!shape(0, 1)) return null;
      const value = BigInt(data[0]!);
      return value > 1n
        ? null
        : { name: "PausedStateChanged", paused: value === 1n };
    }
    default:
      return null;
  }
}

/** campaignId of campaign-scoped events, or null for global events. */
export function eventCampaignId(event: CampaignManagerEvent): string | null {
  return "campaignId" in event ? event.campaignId : null;
}
