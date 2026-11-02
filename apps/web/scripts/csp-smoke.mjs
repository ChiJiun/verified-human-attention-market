import { startNext } from "./next-start.mjs";

const PAGES = [
  ["/", 200],
  ["/advertiser", 200],
  ["/mission", 200],
  ["/smoke-not-found", 404],
  ["/api-keys", 404],
];

const { origin, stop } = await startNext();

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
  await stop();
}

if (failures.length > 0) {
  console.error(`CSP smoke failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`CSP smoke passed on ${PAGES.length} pages`);
