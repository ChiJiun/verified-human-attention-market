/**
 * World ID's IDKit widget needs the bridge for proof delivery, its font host,
 * inline styles in its shadow root and SVG data URIs.
 */
export function contentSecurityPolicy(
  nonce: string,
  mode: { development: false } | { development: true; hmrOrigin: string },
): string {
  return [
    "default-src 'self'",
    // React evals in development to rebuild server stack traces.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${mode.development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' https://world-id-assets.com",
    `connect-src 'self' https://bridge.worldcoin.org${mode.development ? ` ${mode.hmrOrigin}` : ""}`,
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(mode.development ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}
