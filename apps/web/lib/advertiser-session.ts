import { useEffect, useState, useSyncExternalStore } from "react";

import { ApiError, describeError } from "./api";
import {
  restoreSession,
  sessionForWallet,
  signInWithEthereum,
  signOut,
  type Session,
} from "./siwe";
import type { Wallet } from "./wallet";

export interface SessionApi {
  restore(): Promise<Session | null>;
  signIn(wallet: Wallet): Promise<Session>;
  signOut(): Promise<void>;
}

const sameSession = (a: Session | null, b: Session | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.address === b.address &&
    a.expiresAt === b.expiresAt);

const keepCurrentSession = () => undefined;

export function createSessionStore(sessionApi: SessionApi) {
  let session: Session | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();

  function set(next: Session | null) {
    if (sameSession(session, next)) return;
    session = next;
    for (const listener of listeners) listener();
  }

  function supersede(next: Session | null) {
    generation += 1;
    set(next);
  }

  async function restore() {
    const started = generation;
    const restored = await sessionApi.restore();
    if (started === generation) set(restored);
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    current: () => session,
    restore,
    async signIn(wallet: Wallet) {
      supersede(await sessionApi.signIn(wallet));
    },
    async signOut() {
      await sessionApi.signOut();
      supersede(null);
    },
    async syncFromError(error: unknown) {
      if (!(error instanceof ApiError)) return;
      if (error.code === "UNAUTHENTICATED") {
        supersede(null);
      } else if (error.code === "NOT_CAMPAIGN_ADVERTISER") {
        await restore().catch(keepCurrentSession);
      }
    },
  };
}

const browserSession: SessionApi = {
  restore: restoreSession,
  signIn: (wallet) => signInWithEthereum(wallet.walletClient, wallet.address),
  signOut,
};

export function useAdvertiserSession(
  wallet: Wallet | null,
  onError: (message: string) => void,
) {
  const [store] = useState(() => createSessionStore(browserSession));
  const session = useSyncExternalStore(
    store.subscribe,
    store.current,
    () => null,
  );

  useEffect(() => {
    store.restore().catch((caught) => onError(describeError(caught)));
  }, [store, onError]);

  return {
    session,
    active: sessionForWallet(session, wallet),
    signIn: store.signIn,
    signOut: store.signOut,
    syncFromError: store.syncFromError,
  };
}
