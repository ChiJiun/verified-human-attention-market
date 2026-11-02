import type { ApiPath } from "./api";

export type CampaignId = string & { readonly __brand: "CampaignId" };
export type SubmissionId = string & { readonly __brand: "SubmissionId" };

export type CampaignLink =
  { kind: "none" } | { kind: "invalid" } | { kind: "campaign"; id: CampaignId };

type CampaignSubpath =
  | ""
  | "/analytics"
  | "/eligibility/verify"
  | "/mission"
  | "/onchain"
  | "/publish"
  | "/submissions"
  | "/world-id/request";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value)
    ? value.toLowerCase()
    : null;
}

export function parseCampaignId(value: unknown): CampaignId | null {
  return uuid(value) as CampaignId | null;
}

export function parseSubmissionId(value: unknown): SubmissionId | null {
  return uuid(value) as SubmissionId | null;
}

export function campaignLink(search: string): CampaignLink {
  const value = new URLSearchParams(search).get("campaign");

  if (!value) {
    return { kind: "none" };
  }

  const id = parseCampaignId(value);
  return id ? { kind: "campaign", id } : { kind: "invalid" };
}

export function campaignPath(
  id: CampaignId,
  subpath: CampaignSubpath = "",
): ApiPath {
  return `/v1/campaigns/${id}${subpath}` as ApiPath;
}

export function claimAuthorizationPath(
  campaign: CampaignId,
  submission: SubmissionId,
): ApiPath {
  return `/v1/campaigns/${campaign}/submissions/${submission}/authorization` as ApiPath;
}
