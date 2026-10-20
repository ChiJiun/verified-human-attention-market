import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/coverage/**",
      "**/out/**",
      "**/cache/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mjs}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    ignores: ["apps/web/lib/campaign-link.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...[
          "> TSTypeReference.typeAnnotation",
          "> .typeAnnotation TSTypeReference",
        ].map((target) => ({
          selector: `:matches(TSAsExpression, TSTypeAssertion) ${target}[typeName.name=/^(ApiPath|CampaignId|SubmissionId)$/]`,
          message:
            "Parse ids and build API paths with lib/campaign-link.ts instead of casting to the brand.",
        })),
      ],
    },
  },
);
