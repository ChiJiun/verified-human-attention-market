import { ChainMismatchError } from "viem";

/** Walks an error and its causes (viem wraps the wallet's error). */
function someCause(error: unknown, test: (cause: unknown) => boolean) {
  for (
    let current: unknown = error, depth = 0;
    current && depth < 10;
    current = (current as { cause?: unknown }).cause, depth += 1
  ) {
    if (test(current)) return true;
  }
  return false;
}

/** EIP-1193 4001: the user rejected the request, so nothing was sent. */
export function isUserRejection(error: unknown): boolean {
  return someCause(error, (cause) => {
    const candidate = cause as { code?: unknown; name?: unknown };
    return (
      candidate.code === 4001 || candidate.name === "UserRejectedRequestError"
    );
  });
}

/**
 * Errors raised before anything reaches the network: a rejection in the
 * wallet, or viem's check that the wallet is on the expected chain.
 */
export function nothingWasSent(error: unknown): boolean {
  return (
    isUserRejection(error) ||
    someCause(
      error,
      (cause) =>
        cause instanceof ChainMismatchError ||
        (cause as { name?: unknown }).name === "ChainMismatchError",
    )
  );
}
