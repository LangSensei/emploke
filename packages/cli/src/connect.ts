/**
 * Resolve where to talk to the server (`baseUrl`), what auth to send
 * (`apiKey`), and which workspace to scope workspace-aware commands to
 * (`workspaceId`).
 *
 * Precedence (top wins):
 *  - explicit CLI flags (`--server`, `--api-key`, `--workspace`)
 *  - environment (`EMPLOKE_SERVER`, `EMPLOKE_API_KEY`, `EMPLOKE_WORKSPACE`)
 *  - `<EMPLOKE_HOME>/runtime.json` (host/port/apiKey from a recent
 *    `emploke start`); for the workspace, server-side
 *    `GET /api/config.currentWorkspace`
 *  - hard defaults (`http://127.0.0.1:8787`)
 *
 * The runtime-file fallback means a freshly-started local server is
 * usable without any env wiring — `emploke start` writes the file,
 * `emploke workspace list` reads from it.
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
  /** Workspace id; defaults to `EMPLOKE_WORKSPACE` then server's `currentWorkspace`. */
  readonly workspace?: string;
}

/**
 * Resolve the workspace id for a workspace-scoped command.
 *
 * Order:
 *   1. `--workspace <id>` flag
 *   2. `EMPLOKE_WORKSPACE` env
 *   3. `GET /api/config` `currentWorkspace` field
 *   4. Throws — caller must surface a usage error
 *
 * The server fetch is the third-tier fallback so a CLI invoked without
 * any wiring still picks up "the workspace I last opened in the
 * dashboard" without the user having to remember the UUID.
 */
export async function resolveWorkspace(flags: WorkspaceFlags, client: ApiClient): Promise<string> {
  const explicit = nonEmpty(flags.workspace) ?? nonEmpty(process.env.EMPLOKE_WORKSPACE);
  if (explicit) return explicit;
  const cfg = await client.call("config.get");
  if (cfg.currentWorkspace !== null && cfg.currentWorkspace !== "") {
    return cfg.currentWorkspace;
  }
  throw new Error(
    "no workspace: pass --workspace <id>, set EMPLOKE_WORKSPACE, or `emploke workspace use <id>` first",
  );
}

function nonEmpty(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const trimmed = s.trim();
  return trimmed === "" ? undefined : trimmed;
}
