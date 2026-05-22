import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    // Forks, not threads. better-sqlite3's native binding segfaults
    // (Windows 0xC0000005) on worker-thread teardown, which on a
    // pnpm-r run cascades from "this pkg failed" into "every later
    // pkg never ran". Forks isolate per-file with a separate process
    // and the segfault becomes a single localised failure. Match
    // every other emploke pkg.
    pool: "forks",
    testTimeout: 30000,
    // Hook timeout has to clear `emploke start`'s internal
    // `waitForHealth` budget (90s) plus a margin for spawn + the rest
    // of `beforeAll` (mkdtemp + run() overhead). 120s gives ~30s of
    // headroom on top of the 90s wait-for-health.
    hookTimeout: 120000,
    // File-level parallelism IS safe now. The historical concern was
    // `commands.test.ts` + `lifecycle.test.ts` doing 18 + 11 per-test
    // server boots and contending for the same 4 vCPU + disk I/O + AV
    // scan budget on Windows runners. Both files have since been
    // split (issue #163, issue #130 Tier 2): `commands.test.ts` →
    // argv-validation + api-contract + integration-smoke;
    // `lifecycle.test.ts` → argv-validation + spawn-smoke. The
    // remaining spawn-bound files are `integration-smoke.test.ts`
    // (1 boot) and `spawn-smoke.test.ts` (2 boots) — small enough
    // that parallelism wins back the cold-import overhead a
    // serialised run pays per file.
    fileParallelism: true,
  },
});
