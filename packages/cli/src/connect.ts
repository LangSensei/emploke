/**
 * Resolve where to talk to the server (`baseUrl`), what auth to send
 * (`apiKey`), and which workspace to scope workspace-aware commands to
 * (`workspaceId`).
 *
 * Precedence (top wins):
 *  - explicit CLI flags (`--server`, `--api-key`, `--workspace`)
 *  - environment (`EMPLOKE_SERVER`, `EMPLOKE_API_KEY`, `EMPLOKE_WORKSPACE`)
 *  - `<EMPLOKE_HOME>/runtime.json` (host/port/apiKey from a recent
 *    `emploke start`) — for **connection** only
 *  - hard defaults (`http://127.0.0.1:8787`)
 *
 * The runtime-file fallback covers connection (host/port/apiKey) so a
 * freshly-started local server is usable without env wiring. There is
 * NO equivalent fallback for the workspace id — every workspace-scoped
 * command requires `--workspace` or `EMPLOKE_WORKSPACE` explicitly.
 * The previous server-side `currentWorkspace` fallback was removed
 * because it's shared mutable state across every client and races with
 * the dashboard / other CLI processes / AI agents (see
 * `resolveWorkspace` below for the full rationale).
 */

import { resolveEmplokePaths } from "@emploke/paths";
import { ApiClient } from "./api-client.js";
import { readRuntimeFile } from "./runtime-file.js";

export interface ConnectFlags {
  /** Override `EMPLOKE_SERVER`. Trailing slash stripped by the client. */
  readonly server?: string;
  /** Override `EMPLOKE_API_KEY`. Empty string is treated as unset. */
  readonly apiKey?: string;
  /** Override `EMPLOKE_HOME` for runtime.json lookup. */
  readonly home?: string;
}

export interface ConnectionInfo {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
}

/** Default base URL when nothing else is configured. */
export const DEFAULT_BASE_URL = "http://127.0.0.1:8787";

/**
 * Resolve where to send HTTP requests. Pure async — no side effects
 * beyond reading `runtime.json`. Always returns a `baseUrl`; `apiKey`
 * stays undefined when unauthenticated mode is in play.
 */
export async function resolveConnection(flags: ConnectFlags = {}): Promise<ConnectionInfo> {
  const env = process.env;

  let baseUrl = nonEmpty(flags.server) ?? nonEmpty(env.EMPLOKE_SERVER);
  let apiKey = nonEmpty(flags.apiKey) ?? nonEmpty(env.EMPLOKE_API_KEY);

  if (!baseUrl || !apiKey) {
    const paths = resolveEmplokePaths(
      flags.home !== undefined ? { ...env, EMPLOKE_HOME: flags.home } : env,
    );
    let rt: Awaited<ReturnType<typeof readRuntimeFile>> = null;
    try {
      rt = await readRuntimeFile(paths.home);
    } catch {
      // Corrupt runtime.json — treat as absent. The user's flags / env
      // are still honoured; absent both, we fall through to defaults.
    }
    if (rt) {
      if (!baseUrl) {
        const host = rt.host === "0.0.0.0" ? "127.0.0.1" : rt.host;
        baseUrl = `http://${host}:${rt.port}`;
      }
      if (!apiKey && rt.apiKey) apiKey = rt.apiKey;
    }
  }

  return {
    baseUrl: baseUrl ?? DEFAULT_BASE_URL,
    apiKey,
  };
}

/**
 * Build a typed {@link ApiClient} for a CLI command. Wraps
 * {@link resolveConnection} and the constructor in one call so each
 * command stays one line.
 */
export async function makeClient(flags: ConnectFlags = {}): Promise<ApiClient> {
  const conn = await resolveConnection(flags);
  return new ApiClient(
    conn.apiKey !== undefined
      ? { baseUrl: conn.baseUrl, apiKey: conn.apiKey }
      : { baseUrl: conn.baseUrl },
  );
}

export interface WorkspaceFlags extends ConnectFlags {
  /** Workspace id; defaults to `EMPLOKE_WORKSPACE`. There is NO server-side fallback — see `resolveWorkspace`. */
  readonly workspace?: string;
}

/**
 * Resolve the workspace id for a workspace-scoped command.
 *
 * Order:
 *   1. `--workspace <id>` flag
 *   2. `EMPLOKE_WORKSPACE` env
 *   3. Throws — caller's `formatError` surfaces it.
 *
 * NOTE: a previous version added a third tier that fell back to the
 * server's `GET /api/config.currentWorkspace`. That fallback has been
 * REMOVED on purpose — `currentWorkspace` is shared mutable global
 * state across every client of the same emploke server (every CLI
 * process, every dashboard tab, every MCP / external HTTP caller).
 * Falling back to it makes a workspace-scoped command's target
 * silently dependent on whatever the most recent writer chose, which
 * is a CONCURRENCY FOOTGUN for any multi-client (and especially any
 * multi-AI) scenario.
 *
 * Today's two sources are both PROCESS-LOCAL and therefore race-free:
 * `--workspace` is in the call's argv, `EMPLOKE_WORKSPACE` is in the
 * caller's own environment. No cross-client mutation can change the
 * answer between this resolve and the next request. See also the
 * stub at `commands/workspace.ts:workspaceUse` for the dual perspective
 * — the writer side of the same fallback was removed too.
 */
export async function resolveWorkspace(flags: WorkspaceFlags): Promise<string> {
  const explicit = nonEmpty(flags.workspace) ?? nonEmpty(process.env.EMPLOKE_WORKSPACE);
  if (explicit) return explicit;
  throw new Error(
    "no workspace selected.\n" +
      "  Pass --workspace <id> or set EMPLOKE_WORKSPACE.\n" +
      "  Run `emploke workspace list` to see available ids.\n" +
      "  (`emploke workspace use` was removed because the server-side current workspace " +
      "is shared mutable state — see commands/workspace.ts for the full rationale.)",
  );
}

function nonEmpty(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const trimmed = s.trim();
  return trimmed === "" ? undefined : trimmed;
}
