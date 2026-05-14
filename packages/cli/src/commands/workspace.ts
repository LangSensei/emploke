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
//
// `emploke workspace use` — INTENTIONALLY a stub.
//
// What this used to do: PUT /api/workspaces/current to set the
// server-side "current workspace" pointer, which the CLI's
// `resolveWorkspace` would then fall back to when no `--workspace` /
// `EMPLOKE_WORKSPACE` was provided.
//
// Why it's gone: that fallback chain is a CONCURRENCY FOOTGUN. The
// server's `currentWorkspace` is shared mutable global state across
// every client of the same emploke server — every CLI process, every
// dashboard tab, every MCP / external HTTP caller. A second client
// (human, AI agent, even a dashboard reload) writing it between your
// `workspace use` and your next command silently retargets your
// commands at a different workspace. The bug is invisible: no error,
// no warning, the next `task list` just returns the wrong tasks.
//
// What you should do instead: pass `--workspace <id>` on every
// workspace-scoped command, OR `export EMPLOKE_WORKSPACE=<id>` once
// in your shell session. Both are PROCESS-LOCAL — they cannot be
// mutated by anyone else, and the race vanishes. See
// `connect.ts:resolveWorkspace` for the read side of the same change.
//
// Why this stub is kept (and not just deleted from the CLI surface):
// muscle memory + stale tutorials + AI agents copying old recipes will
// still type `emploke workspace use ws-X`. Returning a clear error
// that points at the right alternative is far better DX than
// `error: unknown command 'use'`. It also serves as in-source
// documentation for any future maintainer scanning this file looking
// for `use` and wondering why it's missing — the answer is right
// here, no git-archaeology needed.
//
// The dashboard still uses the underlying `PUT /api/workspaces/current`
// route via its own UI to remember "the workspace I last opened" —
// that's its UX state, not the CLI's scoping mechanism. The route
// stays in the manifest; only the CLI consumer is gone, and
// `route-coverage.test.ts` lists `workspaces.setCurrent` in
// ALLOWED_GAPS to make this intentional.
//
// If you're tempted to re-implement this, please first re-read this
// comment AND the design discussion in PR #92.

export interface WorkspaceUseOpts extends CommonFlags {
  readonly id: string;
}

export async function workspaceUse(opts: WorkspaceUseOpts): Promise<CommandResult> {
  const target = typeof opts.id === "string" && opts.id.trim() !== "" ? opts.id.trim() : "<id>";
  return {
    exitCode: 2,
    stderr:
      "`emploke workspace use` was removed.\n" +
      "\n" +
      "The server-side current workspace is shared mutable state across every CLI process,\n" +
      "dashboard tab, and external client — using it to scope commands races with any other\n" +
      "writer (human, AI agent, dashboard) and silently retargets your next command.\n" +
      "\n" +
      "Use one of:\n" +
      `  emploke <command> --workspace ${target}              # per-command\n` +
      `  export EMPLOKE_WORKSPACE=${target}                   # per-shell-session\n` +
      "\n" +
      "Run `emploke workspace list` to see available ids.\n",
  };
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
