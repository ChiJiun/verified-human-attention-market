import { NextResponse, type NextRequest } from "next/server";

/**
 * Strict Content-Security-Policy with a per-request nonce (Threat Model
 * T-015, #72). Next stamps the nonce it finds in the request's CSP header on
 * every script it renders, so the header goes on the forwarded request as
 * well as on the response, and the root layout renders per request so no
 * page is served from a build-time render without a nonce.
 *
 * World ID's IDKit widget needs the bridge for proof delivery, its font host,
 * inline styles in its shadow root and SVG data URIs; nothing else is open.
 */
function contentSecurityPolicy(
  nonce: string,
  hmrOrigin: string | null,
): string {
  const development = hmrOrigin !== null;

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' https://world-id-assets.com",
    `connect-src 'self' https://bridge.worldcoin.org${development ? ` ${hmrOrigin}` : ""}`,
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(development ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16)),
  ).toString("base64");
  // In development React evals to rebuild server stack traces and Next keeps
  // a hot-reload websocket to this host; http://localhost is not upgraded.
  const hmrOrigin =
    process.env.NODE_ENV === "development"
      ? `${request.nextUrl.protocol === "https:" ? "wss" : "ws"}://${request.nextUrl.host}`
      : null;
  const policy = contentSecurityPolicy(nonce, hmrOrigin);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", policy);
  response.headers.set("x-content-type-options", "nosniff");
  // Not no-referrer: that would send Origin "null" even on same-origin
  // POSTs, which the API's CSRF rule refuses when Fetch Metadata is absent.
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");

  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
