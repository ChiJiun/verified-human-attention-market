import { useEffect, useState, useSyncExternalStore } from "react";

import { describeError } from "./api";
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

export type SessionStore = ReturnType<typeof createSessionStore>;

export function createSessionStore(sessionApi: SessionApi) {
  let session: Session | null = null;
  const listeners = new Set<() => void>();

  function set(next: Session | null) {
    session = next;
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    current: () => session,
    async restore() {
      set(await sessionApi.restore());
    },
    async signIn(wallet: Wallet) {
      set(await sessionApi.signIn(wallet));
    },
    async signOut() {
      set(null);
      await sessionApi.signOut();
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
  };
}
