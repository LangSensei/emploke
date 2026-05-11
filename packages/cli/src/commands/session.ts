/**
 * `emploke session …` — 5 subcommands wrapping the workspace-scoped
 * sessions HTTP surface (list / new / show / rm / spawn).
 *
 * All commands take `--workspace` (or fall back to env / server's
 * current). Identifier flags are positional where unambiguous.
 */

import { makeClient, resolveWorkspace } from "../connect.js";
import { formatError, formatJson, formatRecord, formatTable, pickFormat } from "../output.js";
import type { CommandResult } from "../result.js";

interface CommonFlags {
  readonly server?: string;
  readonly apiKey?: string;
  readonly home?: string;
  readonly workspace?: string;
  readonly output?: string;
  readonly json?: boolean;
}

// ─── list ──────────────────────────────────────────────────────────────
export interface SessionListOpts extends CommonFlags {
  readonly agent?: string;
  readonly createdSince?: string;
  readonly activeSince?: string;
}

export async function sessionList(opts: SessionListOpts = {}): Promise<CommandResult> {
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const query: { agent?: string; createdSince?: string; activeSince?: string } = {};
    if (opts.agent !== undefined) query.agent = opts.agent;
    if (opts.createdSince !== undefined) query.createdSince = opts.createdSince;
    if (opts.activeSince !== undefined) query.activeSince = opts.activeSince;
    const list = await client.call("sessions.list", { params: { id }, query });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(list) };
    return {
      exitCode: 0,
      stdout: formatTable(
        ["id", "agent", "runtime", "createdAt"],
        list.map((s) => [
          (s as { id?: string }).id ?? "",
          (s as { agent?: string }).agent ?? "",
          (s as { runtime?: string }).runtime ?? "",
          (s as { createdAt?: string }).createdAt ?? "",
        ]),
      ),
    };
  } catch (err) {
    return formatError(err);
  }
}

// ─── new ───────────────────────────────────────────────────────────────
export interface SessionNewOpts extends CommonFlags {
  readonly agent: string;
  readonly runtime?: string;
}

export async function sessionNew(opts: SessionNewOpts): Promise<CommandResult> {
  if (typeof opts.agent !== "string" || opts.agent.trim() === "") {
    return { exitCode: 2, stderr: "missing required --agent <name>\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const body: { agent: string; runtime?: string } = { agent: opts.agent };
    if (opts.runtime !== undefined) body.runtime = opts.runtime;
    const session = await client.call("sessions.create", { params: { id }, body });
    const fmt = pickFormat(opts, "table");
    const stdout = fmt === "json" ? formatJson(session) : formatRecord({ ...session });
    return { exitCode: 0, stdout };
  } catch (err) {
    return formatError(err);
  }
}

// ─── show ──────────────────────────────────────────────────────────────
export interface SessionShowOpts extends CommonFlags {
  readonly sid: string;
}

export async function sessionShow(opts: SessionShowOpts): Promise<CommandResult> {
  if (typeof opts.sid !== "string" || opts.sid.trim() === "") {
    return { exitCode: 2, stderr: "session id is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const session = await client.call("sessions.get", { params: { id, sid: opts.sid } });
    const fmt = pickFormat(opts, "table");
    const stdout = fmt === "json" ? formatJson(session) : formatRecord({ ...session });
    return { exitCode: 0, stdout };
  } catch (err) {
    return formatError(err);
  }
}

// ─── rm ────────────────────────────────────────────────────────────────
export interface SessionRmOpts extends CommonFlags {
  readonly sid: string;
  readonly purge?: boolean;
  readonly deleteRuntimeState?: boolean;
}

export async function sessionRm(opts: SessionRmOpts): Promise<CommandResult> {
  if (typeof opts.sid !== "string" || opts.sid.trim() === "") {
    return { exitCode: 2, stderr: "session id is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const query: { purge?: "1"; deleteRuntimeState?: "1" } = {};
    if (opts.purge) query.purge = "1";
    if (opts.deleteRuntimeState) query.deleteRuntimeState = "1";
    await client.call("sessions.delete", { params: { id, sid: opts.sid }, query });
    return { exitCode: 0, stdout: `session ${opts.sid} removed\n` };
  } catch (err) {
    return formatError(err);
  }
}

// ─── spawn ─────────────────────────────────────────────────────────────
export interface SessionSpawnOpts extends CommonFlags {
  readonly sid: string;
  readonly remote?: boolean;
}

export async function sessionSpawn(opts: SessionSpawnOpts): Promise<CommandResult> {
  if (typeof opts.sid !== "string" || opts.sid.trim() === "") {
    return { exitCode: 2, stderr: "session id is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const body: { remote?: boolean } = {};
    if (opts.remote) body.remote = true;
    const result = await client.call("sessions.spawn", {
      params: { id, sid: opts.sid },
      body,
    });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(result) };
    if (result.ok) {
      return {
        exitCode: 0,
        stdout: `spawned via ${result.launcher}\n${result.display}\n`,
      };
    }
    // ok=false: terminal spawn failed but the launch command is still
    // useful — print it so the user can copy/paste.
    return {
      exitCode: 0,
      stdout: `spawn failed (${result.code}: ${result.error})\nrun manually:\n${result.display}\n`,
    };
  } catch (err) {
    return formatError(err);
  }
}
