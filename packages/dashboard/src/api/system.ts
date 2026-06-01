// Cross-cutting server endpoints that aren't workspace-scoped: runtime
// registry, server config, and health probe. These live outside the
// `/api/workspaces/:wsId/...` tree so they have no `workspacePrefix()`
// dependency.

import { fetchJson } from "./http.js";

/**
 * Wire shape returned by `GET /api/runtimes`. Mirrors the server's
 * `RuntimeInfo`. `capabilities` is a free-form bag — known keys today
 * are `remoteSession?: boolean` (Copilot) but the dashboard treats it
 * as plain `Record<string, unknown>` so server-side additions don't
 * require a dashboard rebuild.
 */
export interface RuntimeInfo {
  kind: string;
  capabilities: Record<string, unknown>;
}

export const listRuntimes = (): Promise<RuntimeInfo[]> =>
  fetchJson<RuntimeInfo[]>("/api/runtimes", "runtimes");

export interface ServerConfig {
  emplokeHome: string;
  /** Currently-selected workspace id (UUID) on the server registry, or null. */
  currentWorkspace: string | null;
  host: string;
  port: number;
  /** Native path separator on the server's OS. */
  pathSeparator: string;
  /** Tunables for the dashboard's task list view. */
  tasks: {
    /**
     * Poll cadence for the running task list (ms). Owned by the server so
     * the dashboard never hard-codes a UX-shaping constant.
     */
    pollIntervalMs: number;
  };
}

export const getConfig = (): Promise<ServerConfig> =>
  fetchJson<ServerConfig>("/api/config", "config");

/**
 * Mirrors the server's `HealthResponse` (defined in
 * `@emploke/server/routes/health.ts`). Re-declared here rather than
 * imported because `@emploke/server` is a Node package and the dashboard
 * bundle should not depend on it.
 */
export interface HealthResponse {
  status: "ok";
  name: string;
  version: string;
  startedAt: string;
  uptimeSec: number;
  /** ISO 8601 UTC timestamp at the moment the server formed the response. */
  serverNow: string;
}

export const getHealth = (): Promise<HealthResponse> =>
  fetchJson<HealthResponse>("/api/health", "health");
