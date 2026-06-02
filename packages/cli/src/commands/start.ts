/**
 * `emploke start` — spawn the bundled server as a detached child, write
 * `<EMPLOKE_HOME>/runtime.json`, and block until `/api/health` returns 200
 * (or the spawn-grace timeout elapses).
 *
 * Idempotency rules:
 *  - alive + healthy already        → exit 0, no-op (print existing)
 *  - alive but `/api/health` 404/timeout → exit 4 (refuse to overwrite a
 *    foreign process holding our pid slot)
 *  - stale (pid dead)               → cleanup runtime.json, proceed
 *  - absent runtime.json            → proceed
 *
 * Test seam: `selfBin` and `nodeArgs` let vitest spawn the source CLI
 * via `node --import tsx packages/cli/src/bin.ts serve ...` instead of
 * the bundled binary that doesn't exist during `pnpm test`.
 */

import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { logsDir, resolveEmplokeHome } from "@emploke/server";
import { waitForHealth } from "../health-probe.js";
import type { CommandResult } from "../result.js";
import {
  deleteRuntimeFile,
  isPidAlive,
  type RuntimeFile,
  readRuntimeFile,
  writeRuntimeFile,
} from "../runtime-file.js";
import { resolveSelfBin } from "../server-bundle.js";

export interface StartOpts {
  readonly home?: string;
  readonly port?: number;
  readonly host?: string;
  readonly serveStatic?: boolean;
  readonly staticDir?: string;
  readonly logLevel?: "debug" | "info" | "warn" | "error";
  readonly logFormat?: "pretty" | "json";
  // — test seams —
  /** Override the script path passed to `node`. Default: `process.argv[1]`. */
  readonly selfBin?: string;
  /** Extra args to pass to `node` before the script (e.g. `["--import", "tsx"]`). */
  readonly nodeArgs?: readonly string[];
  /**
   * Total budget for `/api/health` polling after spawn. Default 60000 ms.
   *
   * Generous enough to absorb cold Node.js startup on Windows runners
   * with antivirus in the path. Bumped 15s → 30s after the global.db
   * SQLite migration (opening `DatabaseSync` + WAL pragma negotiation
   * pushed cold-boot past 15s on ~1% of runs); then bumped 30s → 60s
   * after the catalog v2 migration (CI started seeing 30000ms hook
   * timeouts on the `windows-latest` runner — Defender's real-time
   * scanning of the freshly-created SQLite WAL sidecar and the
   * spawned node.exe occasionally compounds with the cold node
   * startup to push the chain past 30s).
   *
   * Real-world boots on macOS/Linux complete in well under a second,
   * and even Windows usually finishes in 1-3s; the extra budget only
   * kicks in when Defender (or some other AV / fs filter driver) is
   * genuinely chewing on the files.
   */
  readonly healthTimeoutMs?: number;
}

export async function start(opts: StartOpts = {}): Promise<CommandResult> {
  const env = process.env;
  const home = resolveEmplokeHome(
    opts.home !== undefined ? { ...env, EMPLOKE_HOME: opts.home } : env,
  );
  const port = opts.port ?? Number(env.PORT || 8787);
  const host = opts.host ?? env.EMPLOKE_HOST ?? "127.0.0.1";
  const healthTimeoutMs = opts.healthTimeoutMs ?? 90_000;

  // Step 1 — idempotency check.
  const existing = await readRuntimeFile(home);
  if (existing && isPidAlive(existing.pid)) {
    const snap = await waitForHealth({
      host: existing.host,
      port: existing.port,
      totalMs: 1500,
    });
    if (snap) {
      return {
        exitCode: 0,
        stdout: `emploke is already running (pid ${existing.pid}, http://${displayHost(existing.host)}:${existing.port})\n`,
      };
    }
    // Pid alive but unresponsive — most likely a foreign process is
    // holding our pid slot, or our own server is wedged. Don't double-
    // start; let the operator stop it first.
    return {
      exitCode: 4,
      stderr: `pid ${existing.pid} is alive but /api/health is not responding; refusing to start a sibling. Run \`emploke stop\` first.\n`,
    };
  }
  if (existing && !isPidAlive(existing.pid)) {
    await deleteRuntimeFile(home);
  }

  // Step 2 — log destination for the child's stdout/stderr (boot errors
  // before pino-roll spins up land here; pino's structured logs go to
  // its own rotated files under <logsDir>).
  await mkdir(logsDir(home), { recursive: true });
  const bootLog = path.join(logsDir(home), "server-boot.log");
  const logFh = await open(bootLog, "a");
  const logFd = logFh.fd;

  // Step 3 — assemble argv for the detached child.
  const selfBin = opts.selfBin ?? resolveSelfBin();
  const nodeArgs = opts.nodeArgs ?? [];
  const childArgs: string[] = [
    ...nodeArgs,
    selfBin,
    "serve",
    "--port",
    String(port),
    "--host",
    host,
  ];
  if (opts.serveStatic === false) childArgs.push("--no-serve-static");
  if (opts.staticDir !== undefined) childArgs.push("--static-dir", opts.staticDir);
  if (opts.logLevel !== undefined) childArgs.push("--log-level", opts.logLevel);
  if (opts.logFormat !== undefined) childArgs.push("--log-format", opts.logFormat);

  // Step 4 — child env. We re-export EMPLOKE_HOME / PORT / EMPLOKE_HOST
  // so the child sees the same values whether they came from the
  // operator's env or were passed via flags.
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    EMPLOKE_HOME: home,
    PORT: String(port),
    EMPLOKE_HOST: host,
  };
  if (opts.staticDir !== undefined) childEnv.EMPLOKE_STATIC_DIR = opts.staticDir;
  if (opts.logLevel !== undefined) childEnv.EMPLOKE_LOG_LEVEL = opts.logLevel;
  if (opts.logFormat !== undefined) childEnv.EMPLOKE_LOG_FORMAT = opts.logFormat;

  // Step 5 — detached spawn. `windowsHide: true` keeps a Windows
  // foreground console from flashing up. `unref` releases the parent's
  // hold on the child so this CLI can exit immediately after the health
  // probe succeeds.
  //
  // The log fd is wrapped in try/finally so a synchronous spawn failure
  // (invalid execPath, EMFILE, ...) doesn't leak it.
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: childEnv,
      windowsHide: true,
    });
  } finally {
    await logFh.close();
  }

  if (typeof child.pid !== "number") {
    return { exitCode: 4, stderr: "failed to spawn server (no pid returned)\n" };
  }
  child.unref();

  // Step 6 — write runtime.json BEFORE the health probe so a Ctrl-C
  // between probe and write doesn't orphan the child without a
  // breadcrumb for `stop` to find.
  const rf: RuntimeFile = {
    schema: 1,
    pid: child.pid,
    host,
    port,
    startedAt: new Date().toISOString(),
    serverArgs: childArgs,
  };
  await writeRuntimeFile(home, rf);

  // Step 7 — wait for the server to actually accept requests.
  const snap = await waitForHealth({ host, port, totalMs: healthTimeoutMs });
  if (!snap) {
    // Boot failed. Best-effort kill, then clean up our breadcrumb so a
    // re-run of `start` doesn't see a stale + alive pid.
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (isPidAlive(child.pid)) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {}
    }
    await deleteRuntimeFile(home);
    return {
      exitCode: 4,
      stderr: `server did not respond to /api/health within ${healthTimeoutMs}ms. See ${bootLog} for stderr.\n`,
    };
  }

  return {
    exitCode: 0,
    stdout: `emploke started (pid ${child.pid}, http://${displayHost(host)}:${port}, version ${snap.version})\n`,
  };
}

function displayHost(host: string): string {
  return host === "0.0.0.0" ? "localhost" : host;
}
