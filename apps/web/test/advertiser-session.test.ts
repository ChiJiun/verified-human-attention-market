import { describe, expect, it } from "vitest";

import { createSessionStore, type SessionApi } from "../lib/advertiser-session";
import { ApiError } from "../lib/api";
import type { Session } from "../lib/siwe";
import type { Wallet } from "../lib/wallet";

const alice: Session = {
  address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  expiresAt: "2026-10-21T12:00:00.000Z",
};
const bob: Session = {
  address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  expiresAt: "2026-10-21T13:00:00.000Z",
};
const wallet = {} as Wallet;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function sessionApi(overrides: Partial<SessionApi> = {}): SessionApi {
  return {
    restore: async () => null,
    signIn: async () => alice,
    signOut: async () => {},
    ...overrides,
  };
}

describe("advertiser session store", () => {
  it("keeps a sign-in that finishes before the restore started at load", async () => {
    const restore = deferred<Session | null>();
    const store = createSessionStore(
      sessionApi({ restore: () => restore.promise }),
    );

    const restoring = store.restore();
    await store.signIn(wallet);
    restore.resolve(null);
    await restoring;

    expect(store.current()).toEqual(alice);
  });

  it("keeps the session when sign-out fails, so it can be retried", async () => {
    const store = createSessionStore(
      sessionApi({
        signOut: async () => {
          throw new ApiError(503, "UNAVAILABLE");
        },
      }),
    );
    await store.signIn(wallet);

    await expect(store.signOut()).rejects.toBeInstanceOf(ApiError);
    expect(store.current()).toEqual(alice);
  });

  it("forgets the session once the API answers UNAUTHENTICATED", async () => {
    const store = createSessionStore(sessionApi());
    await store.signIn(wallet);

    await store.syncFromError(new ApiError(401, "UNAUTHENTICATED"));

    expect(store.current()).toBeNull();
  });

  it("re-reads the cookie when the API says the wallet is not the advertiser", async () => {
    let cookie: Session | null = alice;
    const store = createSessionStore(
      sessionApi({ restore: async () => cookie }),
    );
    await store.restore();
    cookie = bob;

    await store.syncFromError(new ApiError(403, "NOT_CAMPAIGN_ADVERTISER"));

    expect(store.current()).toEqual(bob);
  });

  it("does not notify when a re-read finds the same session", async () => {
    const store = createSessionStore(
      sessionApi({ restore: async () => ({ ...alice }) }),
    );
    await store.restore();
    const before = store.current();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    await store.syncFromError(new ApiError(403, "NOT_CAMPAIGN_ADVERTISER"));

    expect(store.current()).toBe(before);
    expect(notified).toBe(0);
  });

  it("ignores errors that say nothing about the session", async () => {
    const store = createSessionStore(sessionApi());
    await store.signIn(wallet);

    await store.syncFromError(new ApiError(409, "ALREADY_LINKED"));
    await store.syncFromError(new Error("wallet closed"));

    expect(store.current()).toEqual(alice);
  });
});
