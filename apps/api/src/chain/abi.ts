/**
 * CampaignManager event topics / selectors and a strict log decoder.
 *
 * Every event argument is a static 32-byte word, so decoding needs no ABI
 * library. Topic and selector constants are verified against the compiled
 * contract in packages/contracts/test/EventTopics.t.sol (and mirrored by
 * apps/api/test/chain-abi.test.ts), so a contract change cannot silently
 * desynchronize the indexer.
 */

export const EVENT_TOPICS = {
  CampaignCreated:
    "0x633109eec20320eded000fc1e2634211aa7e92ba3f5b15faf6dcdafca05094e4",
  CampaignFunded:
    "0x318daf69d77e946364e804495b2184222324b99fddeb42ab5fd25a919f596e8c",
  RewardClaimed:
    "0x26b1605560a38613ed768e913564f2d9a454c54f88abaeb323ce9a8a8f79ed65",
  CampaignClosed:
    "0x5e6eb33a418de5dbbc17f989f7ae362cdfbb1748c5d603137c767027a354edbc",
  CampaignRefunded:
    "0xce0a95a6a92352cb9e5619426cd86ee5bb0cb44739ad6a7b1a0683d4cd16e536",
  CampaignCancelled:
    "0x403b6718db13878ac16c27decb08f09d3a10f116c7c25af575ff5bfbc11ae9e6",
  SignerUpdated:
    "0x2d025324f0a785e8c12d0a0d91a9caa49df4ef20ff87e0df7213a1d4f3157beb",
  PausedStateChanged:
    "0x9e3a5e37224532dea67b89face185703738a228a6e8a23dee546960180d3be64",
  OwnershipTransferred:
    "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
} as const;

export const FUNCTION_SELECTORS = {
  campaigns: "0x141961bc",
  createCampaign: "0x6ecff6f8",
  fundCampaign: "0x918eab15",
} as const;

export type CampaignManagerEvent =
  | { name: "CampaignCreated"; campaignId: string; advertiser: string }
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
      const advertiser = shape(2, 0) ? address(indexed[1]!) : null;
      return advertiser
        ? { name: "CampaignCreated", campaignId: uint(indexed[0]!), advertiser }
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
