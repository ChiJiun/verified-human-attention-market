import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PAGES = [
  ["/", 200],
  ["/advertiser", 200],
  ["/mission", 200],
  ["/smoke-not-found", 404],
  ["/api-keys", 404],
];
const RESERVED_PORTS = new Set([3000, 3001]);

const webDir = fileURLToPath(new URL("..", import.meta.url));
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

let port = await freePort();
while (RESERVED_PORTS.has(port)) port = await freePort();
const origin = `http://127.0.0.1:${port}`;

const server = spawn(
  process.execPath,
  [nextBin, "start", "--port", String(port), "--hostname", "127.0.0.1"],
  {
    cwd: webDir,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  },
);
let serverLog = "";
server.stdout.on("data", (chunk) => (serverLog += chunk));
server.stderr.on("data", (chunk) => (serverLog += chunk));
const exited = new Promise((resolve) => server.once("exit", resolve));

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) break;
    try {
      await fetch(origin, { signal: AbortSignal.timeout(2_000) });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`next start did not answer on ${origin}\n${serverLog}`);
}

async function load(path) {
  const response = await fetch(`${origin}${path}`, {
    signal: AbortSignal.timeout(30_000),
  });
  const policy = response.headers.get("content-security-policy") ?? "";
  const html = await response.text();
  return {
    status: response.status,
    policy,
    nonce: /'nonce-([^']+)'/.exec(policy)?.[1] ?? null,
    scripts: [...html.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag),
  };
}

const failures = [];

try {
  await waitForServer();

  for (const [path, status] of PAGES) {
    const first = await load(path);
    const second = await load(path);
    const unsigned = first.scripts.filter(
      (tag) => !tag.includes(` nonce="${first.nonce}"`),
    );

    if (first.status !== status)
      failures.push(`${path}: status ${first.status}, expected ${status}`);
    if (!first.policy.includes("'strict-dynamic'"))
      failures.push(`${path}: no CSP with 'strict-dynamic'`);
    if (first.nonce === null) failures.push(`${path}: the CSP has no nonce`);
    if (first.scripts.length === 0)
      failures.push(`${path}: the page has no <script> tags`);
    for (const tag of unsigned)
      failures.push(`${path}: ${tag} lacks the header's nonce`);
    if (second.nonce === null || second.nonce === first.nonce)
      failures.push(`${path}: the nonce did not change between requests`);

    console.log(
      `${path}: ${first.status}, ${first.scripts.length - unsigned.length}/${first.scripts.length} scripts carry the nonce`,
    );
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  server.kill();
  await exited;
}

if (failures.length > 0) {
  console.error(`CSP smoke failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`CSP smoke passed on ${PAGES.length} pages`);
