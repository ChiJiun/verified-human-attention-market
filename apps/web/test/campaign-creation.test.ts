import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiError } from "../lib/api";
import {
  checkLink,
  createAttemptMarker,
  gaveUpMessage,
  keepChecking,
  RETRY_CREATE_AFTER_MS,
  retryCreateOffered,
  type MarkerStorage,
} from "../lib/campaign-creation";
import { campaignPath, parseCampaignId } from "../lib/campaign-link";

const ID = parseCampaignId("3f2b8c1e-9d4a-4e6b-8f1a-2c3d4e5f6a7b")!;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The API answers `POST /onchain` with these, in order. */
function answers(...replies: (readonly [number, unknown] | Error)[]) {
  const fetch = vi.fn(async () => {
    const reply = replies.shift();
    if (!reply) throw new Error("no more answers");
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply[1]), { status: reply[0] });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const reconciling = (code: string) => ({ status: "reconciling", code });
const linkByDraft = () =>
  checkLink(() => api(campaignPath(ID, "/onchain"), { method: "POST" }));
const noWait = vi.fn(async () => {});

describe("linking", () => {
  it("resumes after a transient RPC outage (503) without a reload", async () => {
    const fetch = answers(
      [503, reconciling("RPC_UNAVAILABLE")],
      [202, reconciling("TX_UNCONFIRMED")],
      [200, { id: ID, onchainCampaignId: "1", status: "pending_onchain" }],
    );

    const result = await keepChecking(linkByDraft, {
      attempts: 24,
      delayMs: 5_000,
      sleep: noWait,
    });

    expect(result).toEqual({ kind: "linked" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps checking while the API itself is unreachable", async () => {
    answers(new TypeError("Failed to fetch"), [200, {}]);

    await expect(
      keepChecking(linkByDraft, { attempts: 3, delayMs: 1, sleep: noWait }),
    ).resolves.toEqual({ kind: "linked" });
  });

  it("stops at once on a refusal that waiting cannot change", async () => {
    const fetch = answers([
      422,
      { error: { code: "DRAFT_MISMATCH", retryable: false } },
    ]);

    const failure = await keepChecking(linkByDraft, {
      attempts: 24,
      delayMs: 1,
      sleep: noWait,
    }).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: "DRAFT_MISMATCH" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up with the last reason and asks to press Check again", async () => {
    answers(
      [202, reconciling("NOT_CREATED_YET")],
      [503, reconciling("RPC_UNAVAILABLE")],
    );
    const sleep = vi.fn(async () => {});

    const result = await keepChecking(linkByDraft, {
      attempts: 2,
      delayMs: 5_000,
      sleep,
    });

    expect(result).toEqual({ kind: "reconciling", code: "RPC_UNAVAILABLE" });
    expect(sleep).toHaveBeenCalledExactlyOnceWith(5_000, undefined);
    expect(gaveUpMessage("RPC_UNAVAILABLE")).toMatch(
      /cannot reach the chain.*Press Check again; checking never sends a transaction\.$/,
    );
  });

  it.each([
    ["while a check runs", 0],
    ["while it waits", 50],
  ])("stops checking when the page is left %s", async (_when, afterMs) => {
    const fetch = answers(
      [202, reconciling("NOT_CREATED_YET")],
      [202, reconciling("NOT_CREATED_YET")],
    );
    const left = new AbortController();

    const stopped = keepChecking(linkByDraft, {
      attempts: 24,
      delayMs: 60_000,
      signal: left.signal,
    }).catch((caught: unknown) => caught);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, afterMs));
    left.abort();

    expect(await stopped).toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [null, "unreachable"],
    ["TX_PENDING", "Not confirmed yet"],
    ["NOT_CREATED_YET", "Not confirmed yet"],
    ["TX_UNCONFIRMED", "waiting for confirmations"],
    ["INTERNAL_ERROR", "(INTERNAL_ERROR)"],
  ])("explains why it stopped (%s)", (code, reason) => {
    const message = gaveUpMessage(code);

    expect(message).toContain(reason);
    expect(message).toContain("Press Check again");
  });
});

function memoryStorage(): MarkerStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

const unavailable: MarkerStorage = {
  getItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  removeItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
};

describe("pending-creation marker", () => {
  it("survives a reload through localStorage until the draft is linked", () => {
    const storage = memoryStorage();
    createAttemptMarker(() => storage).begin(ID, 1_000);

    const reloaded = createAttemptMarker(() => storage);
    expect(reloaded.recall(ID)).toBe(1_000);

    reloaded.clear(ID);
    expect(createAttemptMarker(() => storage).recall(ID)).toBeNull();
  });

  it("still offers the manual retry when localStorage throws", () => {
    const marker = createAttemptMarker(() => unavailable);

    marker.begin(ID, 0);

    expect(marker.recall(ID)).toBe(0);
    expect(retryCreateOffered(marker.recall(ID), RETRY_CREATE_AFTER_MS)).toBe(
      false,
    );
    expect(
      retryCreateOffered(marker.recall(ID), RETRY_CREATE_AFTER_MS + 1),
    ).toBe(true);
  });

  it("keeps an earlier attempt's marker when the wallet rejects the retry", () => {
    const storage = memoryStorage();
    const marker = createAttemptMarker(() => storage);
    marker.begin(ID, 1_000);

    // "Create on-chain anyway", rejected in the wallet: nothing new was sent.
    const undo = marker.begin(ID, 700_000);
    expect(marker.recall(ID)).toBe(700_000);

    expect(undo()).toBe(1_000);
    expect(marker.recall(ID)).toBe(1_000);
    expect(createAttemptMarker(() => storage).recall(ID)).toBe(1_000);
  });

  it("clears the marker when the first attempt is rejected", () => {
    const storage = memoryStorage();
    const marker = createAttemptMarker(() => storage);

    const undo = marker.begin(ID, 1_000);

    expect(undo()).toBeNull();
    expect(marker.recall(ID)).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it("ignores a marker that is not a time", () => {
    const storage = memoryStorage();
    storage.items.set(`vham:create-attempt:${ID}`, "garbage");

    expect(createAttemptMarker(() => storage).recall(ID)).toBeNull();
  });
});
