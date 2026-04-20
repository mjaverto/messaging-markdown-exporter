import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // E2E tests only
    include: ["test/e2e/**/*.test.ts"],
    globalSetup: ["test/e2e/globalSetup.ts"],
    // E2E tests can be slower — allow up to 60s per test
    testTimeout: 60000,
  },
});
