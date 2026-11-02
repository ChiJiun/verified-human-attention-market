import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // In CI, failures also become GitHub annotations (readable via the API).
    reporters: process.env.GITHUB_ACTIONS
      ? ["default", "github-actions"]
      : ["default"],
  },
});
