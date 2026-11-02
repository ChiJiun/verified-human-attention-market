import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Ports a developer's own web app and API usually hold.
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

/**
 * Starts the built web app with `next start` on a free port, hidden, and
 * waits until it answers. `stop()` kills it and waits for the exit.
 */
export async function startNext() {
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
  let log = "";
  server.stdout.on("data", (chunk) => (log += chunk));
  server.stderr.on("data", (chunk) => (log += chunk));
  const exited = new Promise((resolve) => server.once("exit", resolve));
  const stop = async () => {
    server.kill();
    await exited;
  };

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) break;
    try {
      await fetch(origin, { signal: AbortSignal.timeout(2_000) });
      return { origin, stop };
    } catch {
      await sleep(500);
    }
  }
  await stop();
  throw new Error(`next start did not answer on ${origin}\n${log}`);
}
