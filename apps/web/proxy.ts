import { NextResponse, type NextRequest } from "next/server";

import { contentSecurityPolicy } from "./lib/csp";

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
