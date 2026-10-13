/**
 * Fixed-window rate limiter (#26). In-process: with several API instances
 * behind a load balancer each enforces its own window, so the effective
 * limit is `instances × limit`; size limits accordingly or move the counter
 * to a shared store before scaling out.
 */
export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  resetSeconds: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<
    string,
    { start: number; count: number }
  >();

  constructor(
    private readonly windowMs = 60_000,
    private readonly maxKeys = 50_000,
  ) {}

  check(key: string, limit: number, now: Date): RateLimitDecision {
    const time = now.getTime();
    let window = this.windows.get(key);

    if (!window || time - window.start >= this.windowMs) {
      if (!window && this.windows.size >= this.maxKeys) {
        this.prune(time);
      }
      window = { start: time, count: 0 };
      this.windows.set(key, window);
    }

    window.count += 1;
    const resetSeconds = Math.max(
      1,
      Math.ceil((window.start + this.windowMs - time) / 1000),
    );

    return {
      allowed: window.count <= limit,
      limit,
      remaining: Math.max(0, limit - window.count),
      resetSeconds,
    };
  }

  private prune(time: number) {
    for (const [key, window] of this.windows) {
      if (time - window.start >= this.windowMs) {
        this.windows.delete(key);
      }
    }

    // Still full (an attack with many keys): drop the oldest entries.
    if (this.windows.size >= this.maxKeys) {
      const excess = this.windows.size - Math.floor(this.maxKeys / 2);
      let removed = 0;
      for (const key of this.windows.keys()) {
        if (removed >= excess) break;
        this.windows.delete(key);
        removed += 1;
      }
    }
  }
}
