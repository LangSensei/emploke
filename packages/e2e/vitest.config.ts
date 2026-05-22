import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // E2E tests boot real servers and spawn the bundled CLI; bump the
    // per-test timeout from vitest's 5s default so the slowest happy
    // path (workspace add -> list -> show -> current -> rm) has slack
    // on cold Windows CI runners.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Forks, not threads. Matches every other emploke pkg (see the
    // template vitest config for the better-sqlite3 segfault rationale)
    // and gives each e2e file its own process so a leaked subprocess
    // can't poison sibling files.
    pool: "forks",
  },
});
