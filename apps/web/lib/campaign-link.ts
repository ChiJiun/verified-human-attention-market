export type CampaignLink =
  { kind: "none" } | { kind: "invalid" } | { kind: "campaign"; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function campaignLink(search: string): CampaignLink {
  const id = new URLSearchParams(search).get("campaign");

  if (!id) {
    return { kind: "none" };
  }

  return UUID.test(id) ? { kind: "campaign", id } : { kind: "invalid" };
}
