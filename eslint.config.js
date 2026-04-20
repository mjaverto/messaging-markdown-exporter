// ESLint flat config for messaging-markdown-exporter.
//
// Base:
//   - @eslint/js recommended
//   - typescript-eslint strict + stylistic (type-aware rules kept off for speed)
//   - eslint-config-prettier last, so formatting decisions belong to Prettier
//
// Relaxed rules for test/**/*.ts:
//   - @typescript-eslint/no-non-null-assertion: tests frequently assert known-good
//     shapes from fixtures/helpers where a non-null assertion is clearer than a
//     conditional guard.
//   - @typescript-eslint/no-explicit-any: tests occasionally need `any` for
//     mocking, partial fixtures, or probing private behavior.
//   - @typescript-eslint/no-empty-function: test doubles / stubs often use noop
//     callbacks.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "**/*.d.ts"],
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.strict, ...tseslint.configs.stylistic],
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },
  {
    // The iMessage adapter parses Apple's binary `attributedBody` streamtyped
    // blobs and has to strip literal control characters from the decoded
    // payload. Those regexes intentionally match NUL and the C0 range, so
    // `no-control-regex` would flag correct code here.
    files: ["src/adapters/imessage.ts"],
    rules: {
      "no-control-regex": "off",
    },
  },
  eslintConfigPrettier,
);
