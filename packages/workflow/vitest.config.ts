import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Forks, not threads. better-sqlite3's native binding segfaults
    // (Windows 0xC0000005) on worker-thread teardown, which on a
    // pnpm-r run cascades from "this pkg failed" into "every later
    // pkg never ran". Forks isolate per-file with a separate process
    // and the segfault becomes a single localised failure instead of
    // a workspace-wide ghost outage. Match every other emploke pkg.
    pool: "forks",
  },
});
