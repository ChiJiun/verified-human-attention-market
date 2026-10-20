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
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@worldcoin/idkit",
              importNames: ["proofOfHuman"],
              message:
                'IDKit 4.4.0\'s proofOfHuman() preset forces allow_legacy_proofs: true, and ADR-0007 accepts only World ID 4.0 proofs. Use constraints={CredentialRequest("proof_of_human")}.',
            },
          ],
        },
      ],
    },
  },
);
