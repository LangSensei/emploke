import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    // `forks` rather than the default `threads`: better-sqlite3's
    // native binding segfaults on worker-thread teardown on Windows.
    pool: "forks",
    testTimeout: 15000,
  },
});
