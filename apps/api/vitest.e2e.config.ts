import { defineConfig } from "vitest/config";

// Local-chain end-to-end POC (issue #13). Needs anvil, compiled contracts
// and PostgreSQL; see .github/workflows/ci.yml (e2e job).
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: process.env.GITHUB_ACTIONS
      ? ["default", "github-actions"]
      : ["default"],
  },
});
