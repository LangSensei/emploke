/**
 * Spawn-based smoke tests for the `emploke` CLI lifecycle.
 *
 * Per issue #130 Tier 2: only cases whose subject of test IS the
 * subprocess + signals + PID-file contract belong here. Everything
 * else moved to `argv-validation.test.ts` (in-process `run()` via
 * `runCli`) so the file pays a minimum of real server boots.
 *
 * Layout:
 *
 *  - `describe.sequential("lifecycle")` boots ONE server in
 *    `beforeAll`, then asserts state transitions on it in order. The
 *    `restart` case implicitly performs a SECOND boot (it kills the
 *    first pid and writes a new one), and the final `stop` case takes
 *    that second boot down. Two boots total for the whole describe
 *    instead of one per case — preserves the old `lifecycle.test.ts`
 *    coverage while removing ~25 s of cold spawn overhead.
 *
 *  - `describe("stale runtime.json")` is independent because it must
 *    NOT have a real server alive (the test asserts that `status`
 *    cleans up a breadcrumb pointing at a dead pid). Its own tmpdir
 *    + its own spawn.
 *
 *  - `describe("bundle smoke")` exercises the actual esbuild output
 *    (`node dist/bin.js --version` / `--help`). The in-process
 *    `run()` seam used by argv-validation imports SOURCE — it can't
 *    catch regressions in the bundler config, the shebang, or the
 *    embedded version. These two ~200 ms cases close that gap.
 *
 * Requires `pnpm build` to have produced `packages/cli/dist/bin.js`
 * (CI does this in the build step before `pnpm test`). Locally, if
 * the bundle is missing, the affected cases skip rather than fail —
 * see the `BIN_AVAILABLE` guard below.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BIN_AVAILABLE, CLI_BIN, pickPort, runBin } from "../_helpers/cli-bundle.js";

// ─── lifecycle (shared boot) ──────────────────────────────────────────

describe.sequential("spawn smoke (lifecycle)", () => {
  let home: string;
  let port: number;
  let env: NodeJS.ProcessEnv;
  let initialPid: number;

  beforeAll(async () => {
    if (!BIN_AVAILABLE) {
      throw new Error(
        `CLI bundle not found at ${CLI_BIN}. Run \`pnpm --filter @emploke/cli build\` first (CI does this in the build step).`,
      );
    }
    home = await mkdtemp(path.join(tmpdir(), "emploke-cli-spawn-"));
    port = pickPort();
    env = { EMPLOKE_HOME: home };
    const r = await runBin(["start", "--port", String(port), "--no-serve-static"], env);
    if (r.exitCode !== 0) {
      throw new Error(`server failed to start (exit ${r.exitCode}): ${r.stderr}`);
    }
    initialPid = JSON.parse(await readFile(path.join(home, "runtime.json"), "utf8")).pid as number;
  });

  afterAll(async () => {
    try {
      await runBin(["stop"], env);
    } catch {
      // Best-effort: a teardown failure shouldn't mask a real test failure.
    }
    // Windows EBUSY mitigation: see comment in integration-smoke.test.ts.
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("start wrote runtime.json with schema=1, recorded port, and a numeric pid", async () => {
    const rfPath = path.join(home, "runtime.json");
    expect(existsSync(rfPath)).toBe(true);
    const rf = JSON.parse(await readFile(rfPath, "utf8"));
    expect(rf.schema).toBe(1);
    expect(rf.port).toBe(port);
    expect(typeof rf.pid).toBe("number");
    expect(rf.pid).toBe(initialPid);
  });

  it("status reports healthy + recorded port for the live server", async () => {
    const r = await runBin(["status"], env);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/healthy/);
    expect(r.stdout).toContain(String(port));
  });

  it("start is idempotent when the server is already alive", async () => {
    const r = await runBin(["start", "--port", String(port), "--no-serve-static"], env);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/already running/);
    const pidNow = JSON.parse(await readFile(path.join(home, "runtime.json"), "utf8"))
      .pid as number;
    expect(pidNow).toBe(initialPid);
  });

  it("restart kills the previous pid and starts a new one", async () => {
    const r = await runBin(["restart", "--port", String(port), "--no-serve-static"], env);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/emploke started/);
    const pidAfter = JSON.parse(await readFile(path.join(home, "runtime.json"), "utf8"))
      .pid as number;
    expect(pidAfter).not.toBe(initialPid);
  });

  it("stop tears the server down and removes runtime.json", async () => {
    const r = await runBin(["stop"], env);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/emploke stopped/);
    expect(existsSync(path.join(home, "runtime.json"))).toBe(false);
  });
});

// ─── stale runtime.json cleanup ───────────────────────────────────────

describe("spawn smoke (status cleans up stale runtime.json)", () => {
  let home: string;

  beforeAll(async () => {
    if (!BIN_AVAILABLE) {
      throw new Error(
        `CLI bundle not found at ${CLI_BIN}. Run \`pnpm --filter @emploke/cli build\` first.`,
      );
    }
    home = await mkdtemp(path.join(tmpdir(), "emploke-cli-stale-"));
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("status cleans up a stale runtime.json (pid no longer alive)", async () => {
    // Hand-craft a runtime.json pointing at a definitely-dead pid.
    const rfPath = path.join(home, "runtime.json");
    await mkdir(home, { recursive: true });
    await writeFile(
      rfPath,
      JSON.stringify({
        schema: 1,
        pid: 999_999,
        host: "127.0.0.1",
        port: 8787,
        startedAt: "2026-05-11T00:00:00.000Z",
        serverArgs: [],
      }),
      "utf8",
    );
    const r = await runBin(["status"], { EMPLOKE_HOME: home });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toMatch(/not running/);
    expect(existsSync(rfPath)).toBe(false);
  });
});

// ─── bundle smoke (esbuild output / shebang) ─────────────────────────

describe("bundle smoke", () => {
  // These cases run the ACTUAL `node dist/bin.js` bundle to catch
  // regressions the in-process `run()` seam can't see — esbuild's
  // CJS/ESM output choice, the shebang line on `bin.js`, the embedded
  // `--version` string read from package.json, and the top-level help
  // assembly across the (post-bundle) merged subcommand registrations.
  //
  // Both cases skip when `dist/bin.js` is missing so a local
  // `pnpm test` run that hasn't built the package yet still works.
  // CI always builds before testing, so this guard never trips there.
  it.skipIf(!BIN_AVAILABLE)("`node dist/bin.js --version` exits 0 with a semver", async () => {
    const r = await runBin(["--version"], {});
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.skipIf(!BIN_AVAILABLE)(
    "`node dist/bin.js --help` exits 0 and lists at least one subcommand",
    async () => {
      const r = await runBin(["--help"], {});
      expect(r.exitCode, r.stderr).toBe(0);
      // The merged top-level help renders a `Commands:` section followed
      // by each registered subcommand. We assert two well-known ones
      // (workspace + task) rather than the full list so individual
      // command renames don't ripple into a bundle-smoke flake.
      expect(r.stdout).toContain("workspace");
      expect(r.stdout).toContain("task");
    },
  );
});
