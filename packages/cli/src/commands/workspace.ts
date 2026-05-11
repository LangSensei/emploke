/**
 * `emploke workspace …` — 8 subcommands wrapping the workspace HTTP
 * surface (list / add / current / use / show / update / rm / reload).
 *
 * Every command takes `--server` / `--api-key` / `--output` (some also
 * `--json` shorthand). Workspace-scoped flags (`--workspace`) live in
 * the family commands (`session`, `task`, `catalog`).
 */

import { makeClient } from "../connect.js";
import { formatError, formatJson, formatRecord, formatTable, pickFormat } from "../output.js";
import type { CommandResult } from "../result.js";

interface CommonFlags {
  readonly server?: string;
  readonly apiKey?: string;
  readonly home?: string;
  readonly output?: string;
  readonly json?: boolean;
}

// ─── list ──────────────────────────────────────────────────────────────
export type WorkspaceListOpts = CommonFlags;

export async function workspaceList(opts: WorkspaceListOpts = {}): Promise<CommandResult> {
  const client = await makeClient(opts);
  try {
    const list = await client.call("workspaces.list");
    const fmt = pickFormat(opts, "table");
    const stdout =
      fmt === "json"
        ? formatJson(list)
        : formatTable(
            ["id", "name", "workdir", "createdAt"],
            list.map((w) => [w.id, w.name, w.workdir, w.createdAt]),
          );
    return { exitCode: 0, stdout };
  } catch (err) {
    return formatError(err);
  }
}

// ─── add ───────────────────────────────────────────────────────────────
export interface WorkspaceAddOpts extends CommonFlags {
  readonly name: string;
  /** Absolute path; server mints `<EMPLOKE_HOME>/workspaces/<uuid>` when omitted. */
  readonly workdir?: string;
  /** Inline JSON for the optional defaults bag. */
  readonly defaults?: string;
}

export async function workspaceAdd(opts: WorkspaceAddOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "missing required --name <name>\n" };
  }
  let defaults: Record<string, unknown> | undefined;
  if (opts.defaults !== undefined) {
    try {
      const parsed = JSON.parse(opts.defaults) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { exitCode: 2, stderr: "--defaults must be a JSON object\n" };
      }
      defaults = parsed as Record<string, unknown>;
    } catch (err) {
      return { exitCode: 2, stderr: `--defaults JSON parse error: ${(err as Error).message}\n` };
    }
  }
  const client = await makeClient(opts);
  try {
    const body = {
      name: opts.name,
      ...(opts.workdir !== undefined ? { workdir: opts.workdir } : {}),
      ...(defaults !== undefined ? { defaults } : {}),
    };
    const ws = await client.call("workspaces.create", { body });
    const fmt = pickFormat(opts, "table");
    const stdout = fmt === "json" ? formatJson(ws) : formatRecord({ ...ws });
    return { exitCode: 0, stdout };
  } catch (err) {
    return formatError(err);
  }
}

// ─── current ───────────────────────────────────────────────────────────
export type WorkspaceCurrentOpts = CommonFlags;

export async function workspaceCurrent(opts: WorkspaceCurrentOpts = {}): Promise<CommandResult> {
  const client = await makeClient(opts);
  try {
    const cur = await client.call("workspaces.getCurrent");
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(cur) };
    return { exitCode: 0, stdout: `${cur.id ?? "(none)"}\n` };
  } catch (err) {
    return formatError(err);
  }
}

// ─── use ───────────────────────────────────────────────────────────────
export interface WorkspaceUseOpts extends CommonFlags {
  readonly id: string;
}

export async function workspaceUse(opts: WorkspaceUseOpts): Promise<CommandResult> {
  if (typeof opts.id !== "string" || opts.id.trim() === "") {
    return { exitCode: 2, stderr: "workspace id is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const cur = await client.call("workspaces.setCurrent", { body: { id: opts.id } });
    return { exitCode: 0, stdout: `current workspace: ${cur.id ?? "(none)"}\n` };
  } catch (err) {
    return formatError(err);
  }
}

// ─── show ──────────────────────────────────────────────────────────────
export interface WorkspaceShowOpts extends CommonFlags {
  readonly id: string;
}

export async function workspaceShow(opts: WorkspaceShowOpts): Promise<CommandResult> {
  if (typeof opts.id !== "string" || opts.id.trim() === "") {
    return { exitCode: 2, stderr: "workspace id is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const ws = await client.call("workspaces.get", { params: { id: opts.id } });
    const fmt = pickFormat(opts, "table");
    const stdout = fmt === "json" ? formatJson(ws) : formatRecord({ ...ws });
    return { exitCode: 0, stdout };
  } catch (err) {
    return formatError(err);
  }
}

// ─── update ────────────────────────────────────────────────────────────
export interface WorkspaceUpdateOpts extends CommonFlags {
  readonly id: string;
  readonly name?: string;
  /** Inline JSON for the defaults bag, or the literal `null` to clear. */
  readonly defaults?: string;
}

export async function workspaceUpdate(opts: WorkspaceUpdateOpts): Promise<CommandResult> {
  if (typeof opts.id !== "string" || opts.id.trim() === "") {
    return { exitCode: 2, stderr: "workspace id is required\n" };
  }
  // The route requires at least one of name / defaults — mirror the
  // server's check up front so we don't waste a round trip.
  if (opts.name === undefined && opts.defaults === undefined) {
    return { exitCode: 2, stderr: "pass at least one of --name <s> or --defaults <json>\n" };
  }
  const body: { name?: string; defaults?: Record<string, unknown> | null } = {};
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.defaults !== undefined) {
    try {
      const parsed = JSON.parse(opts.defaults) as unknown;
      if (parsed === null) {
        body.defaults = null;
      } else if (typeof parsed !== "object" || Array.isArray(parsed)) {
        return { exitCode: 2, stderr: "--defaults must be a JSON object or null\n" };
      } else {
        body.defaults = parsed as Record<string, unknown>;
      }
    } catch (err) {
      return { exitCode: 2, stderr: `--defaults JSON parse error: ${(err as Error).message}\n` };
    }
  }
  const client = await makeClient(opts);
  try {
    const ws = await client.call("workspaces.update", { params: { id: opts.id }, body });
    const fmt = pickFormat(opts, "table");
    const stdout = fmt === "json" ? formatJson(ws) : formatRecord({ ...ws });
    return { exitCode: 0, stdout };
  } catch (err) {
    return formatError(err);
  }
}

// ─── rm ────────────────────────────────────────────────────────────────
export interface WorkspaceRmOpts extends CommonFlags {
  readonly id: string;
  readonly purge?: boolean;
}

export async function workspaceRm(opts: WorkspaceRmOpts): Promise<CommandResult> {
  if (typeof opts.id !== "string" || opts.id.trim() === "") {
    return { exitCode: 2, stderr: "workspace id is required\n" };
  }
  const client = await makeClient(opts);
  try {
    await client.call("workspaces.delete", {
      params: { id: opts.id },
      ...(opts.purge ? { query: { purge: "1" } } : {}),
    });
    return {
      exitCode: 0,
      stdout: `workspace ${opts.id} removed${opts.purge ? " (purged)" : ""}\n`,
    };
  } catch (err) {
    return formatError(err);
  }
}

// ─── reload ────────────────────────────────────────────────────────────
export interface WorkspaceReloadOpts extends CommonFlags {
  readonly id: string;
}

export async function workspaceReload(opts: WorkspaceReloadOpts): Promise<CommandResult> {
  if (typeof opts.id !== "string" || opts.id.trim() === "") {
    return { exitCode: 2, stderr: "workspace id is required\n" };
  }
  const client = await makeClient(opts);
  try {
    await client.call("workspaces.reload", { params: { id: opts.id } });
    return { exitCode: 0, stdout: `workspace ${opts.id} reloaded\n` };
  } catch (err) {
    return formatError(err);
  }
}
