/**
 * Lifecycle integration test — exercises the real CLI bin against a real
 * detached server in a tmpdir, on a random high port. Asserts:
 *   - start writes runtime.json + the spawned server actually answers
 *     /api/health
 *   - status reports `healthy` with the expected pid/port
 *   - re-running start while alive is idempotent
 *   - stop tears the server down and cleans up runtime.json
 *   - re-running stop while absent is idempotent
 *   - restart kills the old pid and starts a new one
 *
 * Requires `pnpm build` to have produced `packages/cli/dist/bin.js`
 * (CI does this before `pnpm test`). Each test gets a fresh tmpdir +
 * random port so they can run in parallel without colliding.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Resolve <repo>/packages/cli/dist/bin.js — `import.meta.url` lives at
// packages/cli/test/lifecycle.test.ts, so back out two dirs.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.join(HERE, "..", "dist", "bin.js");

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function pickPort(): number {
  // High random ephemeral-ish range; collisions are vanishingly rare and
  // the test surface (one server per case) tolerates the rare retry.
  return 30000 + Math.floor(Math.random() * 20000);
}

describe("lifecycle (integration)", () => {
  beforeAll(() => {
    if (!existsSync(CLI_BIN)) {
      throw new Error(
        `CLI bundle not found at ${CLI_BIN}. Run \`pnpm --filter @emploke/cli build\` first (CI does this in the build step).`,
      );
    }
  });

  let home: string;
  let port: number;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "emploke-cli-lc-"));
    port = pickPort();
  });
  afterEach(async () => {
    // Best-effort cleanup: stop anything left running, then remove tmpdir.
    try {
      await run(["stop"], { EMPLOKE_HOME: home });
    } catch {}
    await rm(home, { recursive: true, force: true });
  });

  it("status reports not_running when there is no runtime.json (exit 3)", async () => {
    const res = await run(["status"], { EMPLOKE_HOME: home });
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toMatch(/not running/);
  });

  it("status --json emits machine-readable payload", async () => {
    const res = await run(["status", "--json"], { EMPLOKE_HOME: home });
    expect(res.exitCode).toBe(3);
    const body = JSON.parse(res.stdout);
    expect(body.state).toBe("not_running");
  });

  it("stop is idempotent when nothing is running", async () => {
    const res = await run(["stop"], { EMPLOKE_HOME: home });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/not running/);
  });

  it("start → status → stop happy path", async () => {
    const startRes = await run(["start", "--port", String(port), "--no-serve-static"], {
      EMPLOKE_HOME: home,
    });
    expect(startRes.exitCode, startRes.stderr).toBe(0);
    expect(startRes.stdout).toMatch(/emploke started \(pid \d+/);

    const rfPath = path.join(home, "runtime.json");
    expect(existsSync(rfPath)).toBe(true);
    const rf = JSON.parse(await readFile(rfPath, "utf8"));
    expect(rf.schema).toBe(1);
    expect(rf.port).toBe(port);
    expect(typeof rf.pid).toBe("number");

    const statusRes = await run(["status"], { EMPLOKE_HOME: home });
    expect(statusRes.exitCode).toBe(0);
    expect(statusRes.stdout).toMatch(/healthy/);
    expect(statusRes.stdout).toContain(String(port));

    const stopRes = await run(["stop"], { EMPLOKE_HOME: home });
    expect(stopRes.exitCode).toBe(0);
    expect(stopRes.stdout).toMatch(/emploke stopped/);
    expect(existsSync(rfPath)).toBe(false);
  });

  it("start is idempotent when the server is already alive", async () => {
    const r1 = await run(["start", "--port", String(port), "--no-serve-static"], {
      EMPLOKE_HOME: home,
    });
    expect(r1.exitCode, r1.stderr).toBe(0);
    const pid1 = JSON.parse(await readFile(path.join(home, "runtime.json"), "utf8")).pid;

    const r2 = await run(["start", "--port", String(port), "--no-serve-static"], {
      EMPLOKE_HOME: home,
    });
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toMatch(/already running/);
    const pid2 = JSON.parse(await readFile(path.join(home, "runtime.json"), "utf8")).pid;
    expect(pid2).toBe(pid1);

    await run(["stop"], { EMPLOKE_HOME: home });
  });

  it("restart kills the previous pid and starts a new one", async () => {
    const r1 = await run(["start", "--port", String(port), "--no-serve-static"], {
      EMPLOKE_HOME: home,
    });
    expect(r1.exitCode, r1.stderr).toBe(0);
    const pid1 = JSON.parse(await readFile(path.join(home, "runtime.json"), "utf8")).pid;

    const r2 = await run(["restart", "--port", String(port), "--no-serve-static"], {
      EMPLOKE_HOME: home,
    });
    expect(r2.exitCode, r2.stderr).toBe(0);
    expect(r2.stdout).toMatch(/emploke started/);
    const pid2 = JSON.parse(await readFile(path.join(home, "runtime.json"), "utf8")).pid;
    expect(pid2).not.toBe(pid1);

    await run(["stop"], { EMPLOKE_HOME: home });
  });

  it("status cleans up a stale runtime.json (pid no longer alive)", async () => {
    // Hand-craft a runtime.json pointing at a definitely-dead pid.
    const rfPath = path.join(home, "runtime.json");
    const { writeFile } = await import("node:fs/promises");
    const { mkdir } = await import("node:fs/promises");
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
    const res = await run(["status"], { EMPLOKE_HOME: home });
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toMatch(/not running/);
    expect(existsSync(rfPath)).toBe(false);
  });

  it("no-args prints help on exit 0", async () => {
    const res = await run([], { EMPLOKE_HOME: home });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/Usage:/);
    expect(res.stdout).toContain("emploke");
  });

  it("`emploke help` prints top-level help on exit 0", async () => {
    const res = await run(["help"], { EMPLOKE_HOME: home });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/Commands:/);
    expect(res.stdout).toContain("start");
    expect(res.stdout).toContain("stop");
  });

  it("`emploke help <subcommand>` prints the subcommand help", async () => {
    const res = await run(["help", "start"], { EMPLOKE_HOME: home });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/Usage:[\s\S]*emploke start/);
    expect(res.stdout).toContain("--port");
  });

  it("unknown subcommand exits 2", async () => {
    const res = await run(["zzznotacommand"], { EMPLOKE_HOME: home });
    expect(res.exitCode).toBe(2);
    // commander phrases this as `error: unknown command '<name>'`. Don't
    // pin the exact wording — just assert we got a usage-style stderr
    // that mentions the offending token.
    expect(res.stderr.toLowerCase()).toContain("unknown command");
  });
});
