/**
 * Flags unusual claim-authorization (payout liability) rates. A compromised
 * signer or a fraud wave shows up as a burst of authorizations long before
 * the on-chain budget is exhausted (#21, #23).
 */
export interface PayoutAnomalyConfig {
  windowMs: number;
  /** Max authorizations per campaign within the window. */
  perCampaign: number;
  /** Max authorizations across all campaigns within the window. */
  global: number;
}

export const DEFAULT_PAYOUT_ANOMALY_CONFIG: PayoutAnomalyConfig = {
  windowMs: 5 * 60_000,
  perCampaign: 10,
  global: 50,
};

export type PayoutAnomaly = {
  scope: "campaign" | "global";
  campaignId: string | null;
  count: number;
  limit: number;
};

export class PayoutAnomalyDetector {
  private readonly events: { at: number; campaignId: string }[] = [];

  constructor(
    private readonly config: PayoutAnomalyConfig = DEFAULT_PAYOUT_ANOMALY_CONFIG,
  ) {}

  /** Records one newly issued authorization; returns anomalies, if any. */
  record(campaignId: string, now: Date): PayoutAnomaly[] {
    const cutoff = now.getTime() - this.config.windowMs;

    while (this.events.length > 0 && this.events[0]!.at <= cutoff) {
      this.events.shift();
    }

    this.events.push({ at: now.getTime(), campaignId });

    const anomalies: PayoutAnomaly[] = [];
    const perCampaign = this.events.filter(
      (event) => event.campaignId === campaignId,
    ).length;

    if (perCampaign > this.config.perCampaign) {
      anomalies.push({
        scope: "campaign",
        campaignId,
        count: perCampaign,
        limit: this.config.perCampaign,
      });
    }

    if (this.events.length > this.config.global) {
      anomalies.push({
        scope: "global",
        campaignId: null,
        count: this.events.length,
        limit: this.config.global,
      });
    }

    return anomalies;
  }
}
