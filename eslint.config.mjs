import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const idkitModules = [
  "@worldcoin/idkit",
  "@worldcoin/idkit/hooks",
  "@worldcoin/idkit/expo",
];

const legacyIdkitPresets = [
  "proofOfHuman",
  "passport",
  "mnc",
  "identityCheck",
  "orbLegacy",
  "secureDocumentLegacy",
  "documentLegacy",
  "deviceLegacy",
  "selfieCheckLegacy",
];

const legacyIdkitPresetMessage =
  'IDKit 4.4.0 presets can return World ID 3.0 proofs: proofOfHuman, passport, mnc and identityCheck force allow_legacy_proofs: true, and the *Legacy presets return 3.0 proofs only. ADR-0007 accepts only World ID 4.0 proofs. Use constraints={CredentialRequest(...)}, for example CredentialRequest("proof_of_human"), with allow_legacy_proofs={false}.';

const browserSafeSharedMessage =
  "The web imports only the @vham/shared subpath modules, so they must not import zod, which would ship to the browser. Keep zod schemas in packages/shared/src/index.ts, which only the API imports.";

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
            ...idkitModules.map((name) => ({
              name,
              importNames: legacyIdkitPresets,
              message: legacyIdkitPresetMessage,
            })),
            { name: "@vham/shared", message: browserSafeSharedMessage },
          ],
        },
      ],
      "no-restricted-properties": [
        "error",
        ...legacyIdkitPresets.map((property) => ({
          object: "IDKit",
          property,
          message: legacyIdkitPresetMessage,
        })),
      ],
    },
  },
  {
    files: ["packages/shared/src/**/*.ts"],
    ignores: ["packages/shared/src/index.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "zod", message: browserSafeSharedMessage }] },
      ],
    },
  },
);
