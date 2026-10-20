import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { contentSecurityPolicy } from "../lib/csp";
import { config, proxy } from "../proxy";

const directives = (policy: string) =>
  Object.fromEntries(
    policy.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name, values.join(" ")];
    }),
  );

describe("Content-Security-Policy", () => {
  it("allows only nonce'd scripts and IDKit's hosts in production", () => {
    expect(
      directives(contentSecurityPolicy("abc", { development: false })),
    ).toEqual({
      "default-src": "'self'",
      "script-src": "'self' 'nonce-abc' 'strict-dynamic'",
      "style-src": "'self' 'unsafe-inline'",
      "img-src": "'self' data: blob:",
      "font-src": "'self' https://world-id-assets.com",
      "connect-src": "'self' https://bridge.worldcoin.org",
      "frame-src": "'none'",
      "worker-src": "'none'",
      "object-src": "'none'",
      "base-uri": "'none'",
      "form-action": "'self'",
      "frame-ancestors": "'none'",
      "upgrade-insecure-requests": "",
    });
  });

  it("adds eval and the HMR socket in development, without upgrading to https", () => {
    const policy = directives(
      contentSecurityPolicy("abc", {
        development: true,
        hmrOrigin: "ws://localhost:3000",
      }),
    );

    expect(policy["script-src"]).toBe(
      "'self' 'nonce-abc' 'strict-dynamic' 'unsafe-eval'",
    );
    expect(policy["connect-src"]).toBe(
      "'self' https://bridge.worldcoin.org ws://localhost:3000",
    );
    expect(policy).not.toHaveProperty("upgrade-insecure-requests");
  });
});

describe("proxy", () => {
  const nonceOf = (request: NextRequest) =>
    /'nonce-([^']+)'/.exec(
      proxy(request).headers.get("content-security-policy") ?? "",
    )?.[1];

  it("sends a fresh nonce with every page", () => {
    const first = nonceOf(new NextRequest("http://localhost/advertiser"));
    const second = nonceOf(new NextRequest("http://localhost/advertiser"));

    expect(first).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(second).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(second).not.toBe(first);
  });

  it.each([
    ["/", true],
    ["/advertiser", true],
    ["/mission?campaign=x", true],
    ["/api-keys", true],
    ["/apiary", true],
    ["/api", false],
    ["/api/v1/auth/session", false],
    ["/_next/static/chunks/main.js", false],
    ["/_next/image?url=x", false],
    ["/favicon.ico", false],
  ])("runs on %s: %s", (url, expected) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(expected);
  });

  it("skips prefetches, whose responses are never rendered", () => {
    expect(
      unstable_doesMiddlewareMatch({
        config,
        url: "/advertiser",
        headers: { purpose: "prefetch" },
      }),
    ).toBe(false);
  });
});
