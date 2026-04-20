/**
 * Vitest global setup for E2E tests.
 *
 * Ensures the CLI binary is built before E2E tests run.
 * This runs once before any test files, so `dist/cli.js` always exists.
 *
 * From a clean checkout: `npm ci && npm run build && npm run test:e2e`
 * automatically satisfies this because the pretest:e2e script runs build.
 * The globalSetup is a safety net for manual vitest invocations.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export async function setup(): Promise<void> {
  const root = process.cwd();
  const cliDist = path.join(root, "dist", "cli.js");

  if (!fs.existsSync(cliDist)) {
    console.log("[globalSetup] dist/cli.js not found — running npm run build...");
    execFileSync("npm", ["run", "build"], { stdio: "inherit", cwd: root });
  }
}
