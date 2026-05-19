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
    //
    // Bumped 30s → 60s after observing rotating-flake hook timeouts at
    // exactly 30000ms on the `windows-latest` runner. Cold-boot under
    // Windows Defender real-time scanning of the WAL sidecar
    // occasionally pushes the `emploke start` → `/api/health` chain
    // past 30s; 60s gives that tail enough budget without bandaging
    // a real regression. The root fix is in #130 (function-level CLI
    // tests in lieu of spawn-based integration).
    hookTimeout: 60000,
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
