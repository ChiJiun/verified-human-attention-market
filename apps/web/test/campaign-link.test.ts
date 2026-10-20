import { describe, expect, it } from "vitest";

import {
  campaignLink,
  campaignPath,
  parseCampaignId,
} from "../lib/campaign-link";

const ID = "3f2b8c1e-9d4a-4e6b-8f1a-2c3d4e5f6a7b";

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
  });
});
