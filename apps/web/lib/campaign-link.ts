export type CampaignId = string & { readonly __brand: "CampaignId" };

export type CampaignLink =
  { kind: "none" } | { kind: "invalid" } | { kind: "campaign"; id: CampaignId };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCampaignId(value: string): CampaignId | null {
  return UUID.test(value) ? (value as CampaignId) : null;
}

export function campaignLink(search: string): CampaignLink {
  const value = new URLSearchParams(search).get("campaign");

  if (!value) {
    return { kind: "none" };
  }

  const id = parseCampaignId(value);
  return id ? { kind: "campaign", id } : { kind: "invalid" };
}

export function campaignPath(id: CampaignId, subpath = ""): string {
  return `/v1/campaigns/${id}${subpath}`;
}
