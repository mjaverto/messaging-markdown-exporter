import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests: everything in test/ that is NOT under test/e2e/
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/install.ts", "src/telegram-login.ts"],
      reporter: ["text", "lcov"],
      // Floor set below current levels so normal churn doesn't turn
      // CI red, but a sudden drop (e.g. an entire adapter losing its
      // tests) will. Raise these as coverage climbs.
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 70,
        statements: 75,
      },
    },
  },
});
