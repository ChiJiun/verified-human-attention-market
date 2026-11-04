import { configDefaults, defineConfig } from "vitest/config";

/** Page tests that render React into a DOM; everything else runs in node. */
const DOM_TESTS = "**/*.dom.test.tsx";

export default defineConfig({
  // tsconfig.json keeps JSX as is for Next ("jsx": "preserve"); the tests
  // compile it with React's automatic runtime, as Next does. Vite's own Oxc
  // transform does this, so no React plugin is needed.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    // In CI, failures also become GitHub annotations (readable via the API).
    reporters: process.env.GITHUB_ACTIONS
      ? ["default", "github-actions"]
      : ["default"],
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          exclude: [...configDefaults.exclude, DOM_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          // jsdom rather than happy-dom: the DOM Testing Library's reference
          // environment, and a stable release line (see docs/testing).
          environment: "jsdom",
          include: [DOM_TESTS],
        },
      },
    ],
  },
});
