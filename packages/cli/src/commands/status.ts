/**
 * `emploke status` — read runtime.json, probe the recorded pid, probe
 * `/api/health`, and surface one of three states with distinct exit codes
 * so scripts can branch on them:
 *
 *   - 0: running and healthy
 *   - 3: not running (no runtime.json or pid dead — stale file is GC'd)
 *   - 4: running but unhealthy (pid alive, `/api/health` non-200 / timeout)
 *
 * `--json` flips the output from a one-line human-friendly summary to a
 * structured payload suitable for piping to `jq`.
 */

import { resolveEmplokePaths } from "@emploke/paths";
import { probeHealth } from "../health-probe.js";
import type { CommandResult } from "../result.js";
import { deleteRuntimeFile, isPidAlive, readRuntimeFile } from "../runtime-file.js";

export interface StatusOpts {
  readonly home?: string;
  readonly json?: boolean;
}

interface StatusPayload {
  readonly state: "not_running" | "unhealthy" | "healthy";
  readonly pid?: number;
  readonly host?: string;
  readonly port?: number;
  readonly version?: string;
  readonly uptimeSec?: number;
  readonly startedAt?: string;
  readonly note?: string;
}

export async function status(opts: StatusOpts = {}): Promise<CommandResult> {
  const env = process.env;
  const paths = resolveEmplokePaths(
    opts.home !== undefined ? { ...env, EMPLOKE_HOME: opts.home } : env,
  );
  const home = paths.home;
  const existing = await readRuntimeFile(home);
  if (!existing) {
    return { exitCode: 3, stdout: render({ state: "not_running" }, opts.json) };
  }
  if (!isPidAlive(existing.pid)) {
    await deleteRuntimeFile(home);
    return {
      exitCode: 3,
      stdout: render(
        { state: "not_running", note: `cleaned up stale pid ${existing.pid}` },
        opts.json,
      ),
    };
  }
  const snap = await probeHealth({
    host: existing.host,
    port: existing.port,
    timeoutMs: 1500,
  });
  if (!snap) {
    return {
      exitCode: 4,
      stdout: render(
        {
          state: "unhealthy",
          pid: existing.pid,
          host: existing.host,
          port: existing.port,
        },
        opts.json,
      ),
    };
  }
  return {
    exitCode: 0,
    stdout: render(
      {
        state: "healthy",
        pid: existing.pid,
        host: existing.host,
        port: existing.port,
        version: snap.version,
        uptimeSec: snap.uptimeSec,
        startedAt: snap.startedAt,
      },
      opts.json,
    ),
  };
}

function render(payload: StatusPayload, json: boolean | undefined): string {
  if (json) return `${JSON.stringify(payload)}\n`;
  switch (payload.state) {
    case "not_running":
      return payload.note ? `not running (${payload.note})\n` : "not running\n";
    case "unhealthy":
      return `unhealthy: pid ${payload.pid}, http://${displayHost(payload.host ?? "?")}:${payload.port} did not respond to /api/health\n`;
    case "healthy":
      return `healthy: pid ${payload.pid}, http://${displayHost(payload.host ?? "?")}:${payload.port}, version ${payload.version}, uptime ${payload.uptimeSec}s\n`;
  }
}

function displayHost(host: string): string {
  return host === "0.0.0.0" ? "localhost" : host;
}
