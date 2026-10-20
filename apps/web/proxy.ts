import { NextResponse, type NextRequest } from "next/server";

/**
 * World ID's IDKit widget needs the bridge for proof delivery, its font host,
 * inline styles in its shadow root and SVG data URIs.
 */
function contentSecurityPolicy(
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

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16)),
  ).toString("base64");
  const policy = contentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === "development"
      ? {
          development: true,
          hmrOrigin: `${request.nextUrl.protocol === "https:" ? "wss" : "ws"}://${request.nextUrl.host}`,
        }
      : { development: false },
  );

  const requestHeaders = new Headers(request.headers);
  // Next stamps the nonce it finds in the request's CSP header on every
  // script it renders, so the forwarded request carries the header too.
  requestHeaders.set("content-security-policy", policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", policy);
  response.headers.set("x-content-type-options", "nosniff");
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
