import { ApiError } from "./api";

/**
 * One answer of `POST /v1/campaigns/:id/onchain` (ADR-0011). Not linked is
 * never a failure: the transaction may still be mined, so the page keeps
 * checking and never sends again on its own.
 */
export type LinkCheck =
  | { kind: "linked" }
  | {
      kind: "reconciling";
      /** TX_PENDING, TX_UNCONFIRMED, NOT_CREATED_YET, RPC_UNAVAILABLE, …; null when the API was unreachable. */
      code: string | null;
    };

/**
 * Whether a failed check may simply be repeated: a reconciling answer
 * (`202`, or `503 RPC_UNAVAILABLE`), another retryable API error, or the API
 * unreachable (fetch rejects with a TypeError). Checking never sends a
 * transaction, so repeating it is always safe; anything else is shown.
 */
function linkRetryable(error: unknown): boolean {
  return error instanceof ApiError
    ? error.retryable
    : error instanceof TypeError;
}

/** One link request as a LinkCheck; errors that are not retryable are thrown. */
export async function checkLink(
  request: () => Promise<{ status: number; data: unknown }>,
): Promise<LinkCheck> {
  try {
    const { status, data } = await request();
    if (status === 200) return { kind: "linked" };
    const code = (data as { code?: unknown } | null)?.code;
    return {
      kind: "reconciling",
      code: typeof code === "string" ? code : null,
    };
  } catch (caught) {
    if (!linkRetryable(caught)) throw caught;
    return {
      kind: "reconciling",
      code: caught instanceof ApiError ? caught.code : null,
    };
  }
}

/** Waits `ms`, or less when `signal` aborts. */
function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Checks up to `attempts` times, `delayMs` apart, until linked, so a
 * transient RPC outage resumes on its own (#78). Resolves with the last
 * answer: the caller tells "linked" from "gave up". Rejects with the
 * signal's reason once `signal` aborts (the page was left).
 */
export async function keepChecking(
  check: () => Promise<LinkCheck>,
  {
    attempts,
    delayMs,
    signal,
    sleep = wait,
  }: {
    attempts: number;
    delayMs: number;
    signal?: AbortSignal | undefined;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<LinkCheck> {
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    const last = await check();
    if (last.kind === "linked" || attempt >= attempts) return last;
    await sleep(delayMs, signal);
  }
}

export const CHECK_AGAIN =
  "If the transaction was sent it may still be mined. Press Check again; checking never sends a transaction.";

/** The card once the page stops checking without a link. */
export function gaveUpMessage(code: string | null): string {
  const reason =
    code === null
      ? "The API is unreachable right now."
      : code === "RPC_UNAVAILABLE"
        ? "The API cannot reach the chain right now."
        : code === "TX_UNCONFIRMED"
          ? "The campaign is created on-chain and still waiting for confirmations."
          : code === "TX_PENDING" || code === "NOT_CREATED_YET"
            ? "Not confirmed yet."
            : `The check did not finish (${code}).`;
  return `${reason} ${CHECK_AGAIN}`;
}

/** What the attempt marker needs from localStorage. */
export type MarkerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Per-draft marker that a createCampaign transaction may have been broadcast
 * (set right before the wallet is asked to send, cleared once the draft is
 * linked). The page then offers "Check again" first instead of a second send
 * that would only revert (DraftAlreadyCreated) and cost gas. It is kept in
 * memory and, when available, in localStorage, so it survives a reload; when
 * storage throws (private mode) it lasts until the page is reloaded.
 */
export function createAttemptMarker(storage: () => MarkerStorage) {
  /** This tab's own knowledge, including a cleared marker (null). */
  const memory = new Map<string, number | null>();
  const key = (id: string) => `vham:create-attempt:${id}`;

  function recall(id: string): number | null {
    if (memory.has(id)) return memory.get(id)!;
    try {
      const raw = storage().getItem(key(id));
      const at = raw ? Number(raw) : Number.NaN;
      return Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  }

  function write(id: string, at: number | null) {
    memory.set(id, at);
    try {
      if (at === null) storage().removeItem(key(id));
      else storage().setItem(key(id), String(at));
    } catch {
      // Storage may be unavailable (private mode); memory still holds it.
    }
  }

  return {
    recall,
    /**
     * Marks a new attempt at `at`. The returned undo puts back the marker
     * that was there before and returns it: when the wallet refuses, nothing
     * new was sent, but an earlier attempt may still be pending.
     */
    begin(id: string, at: number): () => number | null {
      const previous = recall(id);
      write(id, at);
      return () => {
        write(id, previous);
        return previous;
      };
    },
    clear(id: string) {
      write(id, null);
    },
  };
}

/** After this long a pending creation is assumed dropped; Create is offered again. */
export const RETRY_CREATE_AFTER_MS = 10 * 60_000;

/** Whether "Create on-chain anyway" is offered for an attempt made at `attemptAt`. */
export function retryCreateOffered(
  attemptAt: number | null,
  nowMs: number,
): boolean {
  return attemptAt !== null && nowMs - attemptAt > RETRY_CREATE_AFTER_MS;
}
