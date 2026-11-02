import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { startNext } from "./next-start.mjs";

/**
 * The API keys per-IP rate limits on X-Forwarded-For, counting
 * TRUST_PROXY_HOPS entries from the end (#75). That count is right only if the
 * /api/* rewrite forwards the header exactly as the proxy in front of the web
 * app set it, and adds no entry of its own. This checks both against the
 * built app, so a Next upgrade that changes either fails here.
 */

// The rewrite destination is fixed when the app is built (API_URL).
const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../.next/routes-manifest.json", import.meta.url)),
    "utf8",
  ),
);
const rewrite = [
  ...(Array.isArray(manifest.rewrites)
    ? manifest.rewrites
    : (manifest.rewrites?.afterFiles ?? [])),
].find((entry) => entry.source === "/api/:path*");
if (!rewrite) {
  console.error("No /api/:path* rewrite in the built routes manifest");
  process.exit(1);
}
const apiPort = Number(new URL(rewrite.destination.split("/:path")[0]).port);

const received = [];
const api = createServer((request, response) => {
  received.push(request.headers["x-forwarded-for"] ?? null);
  response.writeHead(200, { "content-type": "application/json" });
  response.end("{}");
});
try {
  // No host: dual-stack, so "localhost" resolving to ::1 or 127.0.0.1 both land here.
  await new Promise((resolve, reject) => {
    api.once("error", reject);
    api.listen(apiPort, resolve);
  });
} catch (error) {
  console.error(
    `Cannot listen on the rewrite's port ${apiPort} (${error.code ?? error}). Stop the local API, or build the web app with API_URL on a free port.`,
  );
  process.exit(1);
}

const CASES = [
  // [header the proxy in front of the web app sends, header the API must see]
  [null, null],
  ["203.0.113.7", "203.0.113.7"],
  ["198.51.100.23, 203.0.113.7", "198.51.100.23, 203.0.113.7"],
];
const failures = [];
const { origin, stop } = await startNext();

try {
  for (const [sent, expected] of CASES) {
    received.length = 0;
    const response = await fetch(`${origin}/api/v1/forwarded-for-smoke`, {
      headers: sent === null ? {} : { "x-forwarded-for": sent },
      signal: AbortSignal.timeout(30_000),
    });
    await response.arrayBuffer();
    const seen = received[0];

    if (response.status !== 200 || received.length !== 1) {
      failures.push(
        `sent ${sent ?? "no header"}: status ${response.status}, ${received.length} request(s) reached the API`,
      );
    } else if (seen !== expected) {
      failures.push(
        `sent ${sent ?? "no header"}: the API saw ${seen ?? "no header"}, expected ${expected ?? "no header"}`,
      );
    } else {
      console.log(
        `sent ${sent ?? "no header"}: the API saw ${seen ?? "no header"}`,
      );
    }
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await stop();
  await new Promise((resolve) => api.close(resolve));
}

if (failures.length > 0) {
  console.error(`X-Forwarded-For smoke failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(
  "X-Forwarded-For smoke passed: the /api rewrite forwards the header unchanged and adds no entry",
);
