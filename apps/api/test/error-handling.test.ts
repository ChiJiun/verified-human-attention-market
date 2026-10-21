import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { InMemoryCampaignRepository } from "../src/campaigns/repository.js";
import { signedInAs } from "./support/auth.js";

const VALID_CAMPAIGN = {
  advertiser: "0x1234567890ABCDEF1234567890ABCDEF12345678",
  contentUrl: "https://example.com/sponsored-content",
  rewardPerCompletion: "1000000",
  maxCompletions: 10,
  startAt: "2100-10-05T10:15:00.000Z",
  endAt: "2100-10-05T11:15:00.000Z",
  mission: {
    questions: [
      {
        id: "q1",
        prompt: "Which feature did the article highlight?",
        choices: [
          { id: "a", label: "Speed" },
          { id: "b", label: "Price" },
        ],
      },
    ],
    answerKey: { q1: "a" },
  },
};

const closers: { close(): Promise<unknown> }[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((app) => app.close()));
});

const SQL_MESSAGE =
  'Failed query: select "id" from "campaigns" where "id" = $1 for update\nparams: 0x1111111111111111111111111111111111111111';

function appThatThrows(error: Error) {
  const app = buildApp();
  closers.push(app);
  app.get("/test/throws", async () => {
    throw error;
  });
  return app;
}

describe("unexpected errors", () => {
  it("answer a generic 500 in the documented shape without the thrown message", async () => {
    const app = appThatThrows(new Error(SQL_MESSAGE));

    const response = await app.inject({ method: "GET", url: "/test/throws" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        requestId: response.headers["x-request-id"],
        retryable: true,
      },
    });
    expect(response.body).not.toContain("Failed query");
    expect(response.body).not.toContain("0x1111");
  });

  it("hide the message of an error that carries a 5xx status", async () => {
    const error = Object.assign(new Error(SQL_MESSAGE), { statusCode: 503 });
    const app = appThatThrows(error);

    const response = await app.inject({ method: "GET", url: "/test/throws" });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("Failed query");
    expect(response.json().error.code).toBe("INTERNAL_ERROR");
  });

  it.each([null, undefined])("answer a thrown %s as a generic 500", async (thrown) => {
    const app = buildApp();
    closers.push(app);
    app.get("/test/throws", async () => {
      throw thrown;
    });

    const response = await app.inject({ method: "GET", url: "/test/throws" });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("INTERNAL_ERROR");
  });

  it("echo a well-formed caller request id", async () => {
    const app = appThatThrows(new Error(SQL_MESSAGE));

    const response = await app.inject({
      method: "GET",
      url: "/test/throws",
      headers: { "x-request-id": "caller-request-1" },
    });

    expect(response.json().error.requestId).toBe("caller-request-1");
  });
});

describe("errors Fastify raises itself", () => {
  it("answer an undecodable URL in the documented shape without echoing it", async () => {
    const app = buildApp();
    closers.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/campaigns/%zz",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "Invalid request",
        requestId: response.headers["x-request-id"],
        retryable: false,
      },
    });
    expect(response.body).not.toContain("%zz");
  });

  it("keep 400 for malformed JSON", async () => {
    const app = buildApp();
    closers.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { "content-type": "application/json" },
      payload: '{"title": ',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toEqual({
      code: "INVALID_REQUEST",
      message: "Invalid request",
      requestId: response.headers["x-request-id"],
      retryable: false,
    });
  });

  it("keep 413 for an oversized body", async () => {
    const app = buildApp();
    closers.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ filler: "x".repeat(1_100_000) }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      retryable: false,
    });
  });

  it("keep 415 for an unsupported media type", async () => {
    const app = buildApp();
    closers.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { "content-type": "application/xml" },
      payload: "<a/>",
    });

    expect(response.statusCode).toBe(415);
    expect(response.json().error).toMatchObject({
      code: "UNSUPPORTED_MEDIA_TYPE",
      retryable: false,
    });
  });

  it("keep 404 for an unknown route", async () => {
    const app = buildApp();
    closers.push(app);

    const response = await app.inject({ method: "GET", url: "/v1/nothing" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toEqual({
      code: "ROUTE_NOT_FOUND",
      message: "Route not found",
      requestId: response.headers["x-request-id"],
      retryable: false,
    });
  });
});

describe("error logging", () => {
  function capture(dependencies: Parameters<typeof buildApp>[0] = {}) {
    const lines: string[] = [];
    const app = buildApp({
      ...dependencies,
      logStream: { write: (line: string) => void lines.push(line) },
    });
    closers.push(app);
    return { app, entries: () => lines.map((line) => JSON.parse(line)) };
  }

  it("records the full unexpected error once, at error, with the request id", async () => {
    const { app, entries } = capture();
    app.get("/boom", async () => {
      throw Object.assign(new Error(SQL_MESSAGE), {
        signature: "0xdeadbeef",
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/boom",
      headers: { "x-request-id": "caller-request-2" },
    });

    expect(response.body).not.toContain("Failed query");
    const failures = entries().filter((entry) => entry.level === 50);
    expect(failures).toHaveLength(1);
    expect(failures[0].requestId).toBe("caller-request-2");
    expect(failures[0].err.message).toContain("Failed query");
    expect(failures[0].err.stack).toContain("Error");
    expect(failures[0].err.signature).toBe("[redacted]");
  });

  it("adds one event line without the error on a critical route", async () => {
    const campaigns = new InMemoryCampaignRepository();
    campaigns.createIdempotent = async () => {
      throw new Error(SQL_MESSAGE);
    };
    const { app, entries } = capture({
      authenticate: signedInAs(),
      campaignRepository: campaigns,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "boom-1",
        "x-request-id": "caller-request-3",
      },
      payload: JSON.stringify(VALID_CAMPAIGN),
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("Failed query");
    const failures = entries().filter((entry) => entry.level === 50);
    expect(failures).toHaveLength(2);
    expect(failures.filter((entry) => entry.err)).toHaveLength(1);
    const event = failures.find((entry) => !entry.err);
    expect(event).toMatchObject({
      requestId: "caller-request-3",
      outcome: "INTERNAL_ERROR",
      statusCode: 500,
    });
    expect(JSON.stringify(event)).not.toContain("Failed query");
  });

  it("does not log a client error at error level", async () => {
    const { app, entries } = capture();

    const response = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { "content-type": "application/json" },
      payload: "{",
    });

    expect(response.statusCode).toBe(400);
    expect(entries().filter((entry) => entry.level >= 50)).toEqual([]);
  });
});
