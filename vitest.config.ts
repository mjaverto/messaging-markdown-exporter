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
    },
  },
});
