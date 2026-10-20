import { describe, expect, it } from "vitest";

import {
  campaignLink,
  campaignPath,
  claimAuthorizationPath,
  parseCampaignId,
  parseSubmissionId,
} from "../lib/campaign-link";

const ID = "3f2b8c1e-9d4a-4e6b-8f1a-2c3d4e5f6a7b";
const SUBMISSION = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

describe("campaign links", () => {
  it.each([
    ["", { kind: "none" }],
    ["?campaign=", { kind: "none" }],
    ["?other=1", { kind: "none" }],
    ["?campaign=not-a-uuid", { kind: "invalid" }],
    ["?campaign=../../auth/logout", { kind: "invalid" }],
    [`?campaign=${ID}/analytics`, { kind: "invalid" }],
    [`?campaign=${ID}`, { kind: "campaign", id: ID }],
  ])("reads %j", (search, expected) => {
    expect(campaignLink(search)).toEqual(expected);
  });

  it("canonicalizes a campaign id to the API's lowercase form", () => {
    expect(parseCampaignId(ID.toUpperCase())).toBe(ID);
    expect(campaignLink(`?campaign=${ID.toUpperCase()}`)).toEqual({
      kind: "campaign",
      id: ID,
    });
  });

  it("refuses anything that is not a UUID", () => {
    expect(parseCampaignId("")).toBeNull();
    expect(parseCampaignId(`${ID} `)).toBeNull();
    expect(parseCampaignId(`${ID}?x=1`)).toBeNull();
  });

  it("builds API paths under the campaign", () => {
    const id = parseCampaignId(ID)!;

    expect(campaignPath(id)).toBe(`/v1/campaigns/${ID}`);
    expect(campaignPath(id, "/analytics")).toBe(
      `/v1/campaigns/${ID}/analytics`,
    );
    expect(
      claimAuthorizationPath(id, parseSubmissionId(SUBMISSION.toUpperCase())!),
    ).toBe(`/v1/campaigns/${ID}/submissions/${SUBMISSION}/authorization`);
  });

  it("accepts only a UUID as a submission id", () => {
    expect(parseSubmissionId(SUBMISSION)).toBe(SUBMISSION);
    expect(parseSubmissionId("../../auth/logout")).toBeNull();
    expect(parseSubmissionId(42)).toBeNull();
    expect(parseSubmissionId(null)).toBeNull();
  });
});
