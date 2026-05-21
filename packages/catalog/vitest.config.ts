import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    // Use forks instead of threads: better-sqlite3 native module segfaults
    // on Windows when the worker thread tears down (exit code 3221225477 =
    // 0xC0000005 access violation). Forks let each test file's process
    // exit cleanly without poisoning the parent runner.
    pool: "forks",
    testTimeout: 15000,
  },
});
