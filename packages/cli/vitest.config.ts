import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    pool: "threads",
    testTimeout: 30000,
    // Match testTimeout so beforeEach hooks that boot a real server
    // (commands.test.ts: `emploke start` + 15s waitForHealth budget)
    // don't trip the 10s default on slow Windows runners. Observed
    // hook timeouts at exactly 10000ms in CI under load.
    hookTimeout: 30000,
  },
});
