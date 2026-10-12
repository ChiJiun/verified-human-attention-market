export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was already used with a different request");
    this.name = "IdempotencyConflictError";
  }
}

interface PostgresErrorLike {
  code?: unknown;
  constraint_name?: unknown;
  cause?: unknown;
}

/**
 * Returns the violated constraint name when `error` (or any error in its
 * `cause` chain, e.g. a DrizzleQueryError wrapping a postgres.js error) is a
 * PostgreSQL unique violation (SQLSTATE 23505). Returns null otherwise.
 */
export function uniqueViolationConstraint(error: unknown): string | null {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== "object") {
      return null;
    }

    const candidate = current as PostgresErrorLike;

    if (candidate.code === "23505") {
      return typeof candidate.constraint_name === "string"
        ? candidate.constraint_name
        : "";
    }

    current = candidate.cause;
  }

  return null;
}
