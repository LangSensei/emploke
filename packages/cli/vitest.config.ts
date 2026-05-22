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
    // Match testTimeout + healthTimeoutMs so beforeEach hooks that
    // boot a real server (commands.test.ts: `emploke start` + 60s
    // waitForHealth budget) don't trip the 10s default on slow
    // Windows runners. Observed hook timeouts at exactly 10000ms in
    // CI under load.
    //
    // Bumped 30s → 90s alongside `emploke start`'s healthTimeoutMs
    // bump (30s → 60s). The hook timeout has to be > the server's
    // own internal budget plus a small margin for spawn + the rest
    // of beforeEach (mkdtemp + run() overhead) — 90s gives ~30s of
    // headroom on top of the 60s wait-for-health.
    hookTimeout: 90000,
    // The two server-booting integration files in this package
    // (`commands.test.ts` and `lifecycle.test.ts`) used to race for
    // the same 4 vCPU + disk I/O + AV scan budget on Windows runners
    // when vitest scheduled them in parallel, doubling the apparent
    // cold-boot wall time. Same-package files now run sequentially.
    // Cross-package parallelism is unaffected (the workspace runner
    // still kicks off catalog/server/cli concurrently). This trades
    // ~15s wall time on `pnpm --filter @emploke/cli test` for
    // measurable stability on Windows.
    fileParallelism: false,
  },
});
