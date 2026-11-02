import { randomBytes, randomUUID } from "node:crypto";

import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import { InMemoryCampaignRepository } from "../src/campaigns/repository.js";
import { InMemoryClaimRepository } from "../src/claims/repository.js";
import { InMemoryEligibilityRepository } from "../src/eligibility/repository.js";
import {
  deriveParticipantKey,
  PARTICIPANT_KEY_PATTERN,
} from "../src/privacy/participant-key.js";
import {
  hashSubmissionRequest,
  InMemorySubmissionRepository,
} from "../src/submissions/repository.js";
import { defineCampaignLinkContract } from "./support/campaign-link-contract.js";
import {
  defineClaimRepositoryContract,
  type ClaimHarness,
} from "./support/claim-contract.js";
import {
  definePersistenceContract,
  type PersistenceHarness,
} from "./support/persistence-contract.js";

describe("in-memory campaign repository", () => {
  defineCampaignLinkContract(() => new InMemoryCampaignRepository());
});

describe("in-memory claim repository", () => {
  const contractAddress: Address = `0x${"2".repeat(40)}`;
  const submissions = new Map<string, { campaignId: string; result: string }>();
  const campaigns = new Map<
    string,
    {
      status: string;
      maxCompletions: number;
      onchainCampaignId: string;
      onchainContractAddress: string;
    }
  >();
  let nextOnchainId = 1;
  const submission = async (campaignId: string, result: string) => {
    const submissionId = randomUUID();
    submissions.set(submissionId, { campaignId, result });
    return {
      submissionId,
      claimant: `0x${randomBytes(20).toString("hex")}` as Address,
    };
  };
  const harness: ClaimHarness = {
    claims: new InMemoryClaimRepository(
      async (id) => submissions.get(id) ?? null,
      async (id) => campaigns.get(id) ?? null,
    ),
    linkedCampaign: async () => {
      const campaignId = randomUUID();
      const onchainCampaignId = String(nextOnchainId++);
      campaigns.set(campaignId, {
        status: "active",
        maxCompletions: 10,
        onchainCampaignId,
        onchainContractAddress: contractAddress,
      });
      return { campaignId, onchainCampaignId, contractAddress };
    },
    acceptedSubmission: (campaignId) => submission(campaignId, "accepted"),
    rejectedSubmission: (campaignId) => submission(campaignId, "rejected"),
  };

  defineClaimRepositoryContract(() => harness);
});

describe("in-memory eligibility + submission repositories", () => {
  const eligibility = new InMemoryEligibilityRepository();
  const harness: PersistenceHarness = {
    eligibility,
    submissions: new InMemorySubmissionRepository(eligibility),
    createCampaign: async () => randomUUID(),
    missionIdFor: async () => randomUUID(),
  };

  definePersistenceContract(() => harness);
});

describe("deriveParticipantKey", () => {
  const secret = "a".repeat(32);

  it("is deterministic and never contains the raw subject", () => {
    const key = deriveParticipantKey(secret, "campaign-1", "nullifier-xyz");

    expect(key).toBe(
      deriveParticipantKey(secret, "campaign-1", "nullifier-xyz"),
    );
    expect(key).toMatch(PARTICIPANT_KEY_PATTERN);
    expect(key).not.toContain("nullifier");
  });

  it("is scoped to the campaign and the secret", () => {
    const key = deriveParticipantKey(secret, "campaign-1", "subject");

    expect(deriveParticipantKey(secret, "campaign-2", "subject")).not.toBe(key);
    expect(
      deriveParticipantKey("b".repeat(32), "campaign-1", "subject"),
    ).not.toBe(key);
  });

  it("rejects weak secrets and empty inputs", () => {
    expect(() => deriveParticipantKey("short", "c", "s")).toThrow();
    expect(() => deriveParticipantKey(secret, "", "s")).toThrow();
    expect(() => deriveParticipantKey(secret, "c", "")).toThrow();
  });
});

describe("hashSubmissionRequest", () => {
  const base = {
    campaignId: "campaign-1",
    claimantAddress: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD",
    answers: [
      { questionId: "q1", normalizedAnswer: { choice: "a" } },
      { questionId: "q2", normalizedAnswer: { choice: "b" } },
    ],
  };

  it("ignores answer order and address casing", () => {
    expect(
      hashSubmissionRequest({
        ...base,
        claimantAddress: base.claimantAddress.toLowerCase(),
        answers: [...base.answers].reverse(),
      }),
    ).toBe(hashSubmissionRequest(base));
  });

  it("changes when an answer changes", () => {
    expect(
      hashSubmissionRequest({
        ...base,
        answers: [
          { questionId: "q1", normalizedAnswer: { choice: "c" } },
          { questionId: "q2", normalizedAnswer: { choice: "b" } },
        ],
      }),
    ).not.toBe(hashSubmissionRequest(base));
  });
});
