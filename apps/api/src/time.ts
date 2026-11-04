/** One day in milliseconds. */
export const DAY_MS = 24 * 60 * 60_000;

/** Whole Unix seconds of `date`, rounded down (block timestamps, uint64 fields). */
export const unixSeconds = (date: Date): number =>
  Math.floor(date.getTime() / 1000);

/** The instant of a Unix-seconds timestamp. */
export const fromUnixSeconds = (seconds: bigint): Date =>
  new Date(Number(seconds) * 1000);
