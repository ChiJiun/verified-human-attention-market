/** What `?campaign=` in the page URL resolved to. */
export type CampaignLink =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "campaign"; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Campaign ids are server-generated UUIDs; anything else never reaches a
 * request path. With an ambient session cookie, a crafted link could
 * otherwise make the page call other same-origin endpoints (#72).
 */
export function campaignLink(search: string): CampaignLink {
  const id = new URLSearchParams(search).get("campaign");

  if (!id) {
    return { kind: "none" };
  }

  return UUID.test(id) ? { kind: "campaign", id } : { kind: "invalid" };
}
