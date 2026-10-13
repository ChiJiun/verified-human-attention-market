/**
 * Content URL policy for advertiser-supplied links (#24, Threat Model T-010).
 *
 * Syntactic checks only: they stop the obvious phishing/SSRF-style shapes
 * (other schemes, embedded credentials, raw IPs, internal hosts, odd ports).
 * Whether the destination is safe is decided by the moderation review.
 */

export type ContentUrlViolation =
  | "NOT_HTTPS"
  | "TOO_LONG"
  | "HAS_CREDENTIALS"
  | "IP_HOST"
  | "INTERNAL_HOST"
  | "NON_DEFAULT_PORT"
  | "DOMAIN_NOT_ALLOWED";

export interface ContentUrlPolicy {
  /** When set, only these domains (and their subdomains) are accepted. */
  allowedDomains: readonly string[] | null;
}

const MAX_LENGTH = 2048;
const INTERNAL_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "intranet",
  "lan",
  "home.arpa",
  "invalid",
  "onion",
];
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function checkContentUrl(
  value: string,
  policy: ContentUrlPolicy = { allowedDomains: null },
): ContentUrlViolation | null {
  if (value.length > MAX_LENGTH) {
    return "TOO_LONG";
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return "NOT_HTTPS";
  }

  if (url.protocol !== "https:") {
    return "NOT_HTTPS";
  }

  if (url.username !== "" || url.password !== "") {
    return "HAS_CREDENTIALS";
  }

  // WHATWG URL normalizes hosts: lowercase, punycode, IPv4 shorthands
  // (e.g. https://0x7f.1) become dotted quads, IPv6 keeps brackets.
  const host = url.hostname.replace(/\.$/, "");

  if (host.startsWith("[") || IPV4.test(host)) {
    return "IP_HOST";
  }

  if (
    !host.includes(".") ||
    INTERNAL_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  ) {
    return "INTERNAL_HOST";
  }

  if (url.port !== "") {
    return "NON_DEFAULT_PORT";
  }

  if (
    policy.allowedDomains !== null &&
    !policy.allowedDomains.some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    )
  ) {
    return "DOMAIN_NOT_ALLOWED";
  }

  return null;
}
