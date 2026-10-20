import { api } from "../lib/api";
import { campaignPath, type CampaignId } from "../lib/campaign-link";

export function apiPathsComeFromValidatedIds(id: CampaignId, raw: string) {
  // @ts-expect-error a free-form subpath could address any endpoint
  campaignPath(id, `/submissions/${raw}/authorization`);
  // @ts-expect-error a plain string is not an API path
  return api(`/v1/campaigns/${raw}`);
}
