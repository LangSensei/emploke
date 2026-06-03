import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    // `forks` (not the default `threads`) — better-sqlite3's native
    // binding segfaults on worker-thread teardown on Windows; fork
    // isolation sidesteps that. Do not switch back without verifying
    // Windows CI stays green.
    pool: "forks",
    testTimeout: 15000,
  },
});
