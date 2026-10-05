import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { CampaignRepository } from "../src/campaigns/repository.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("health endpoints", () => {
  it("returns liveness", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("returns readiness when dependencies are healthy", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      checks: {
        process: "ok",
        database: "ok",
      },
    });
  });

  it("returns 503 when the repository is unavailable", async () => {
    const repository: CampaignRepository = {
      createIdempotent: async () => {
        throw new Error("not used");
      },
      getById: async () => null,
      ping: async () => {
        throw new Error("database unavailable");
      },
    };

    const app = buildApp({ campaignRepository: repository });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "error",
      checks: {
        process: "ok",
        database: "error",
      },
    });
  });
});
