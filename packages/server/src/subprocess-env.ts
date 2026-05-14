/**
 * Builds the static portion of the env bag that the server hands to
 * every task-spawned subprocess. Per-task additions
 * (`EMPLOKE_WORKSPACE`, `EMPLOKE_WORKDIR`, `EMPLOKE_TASK_ID`) are layered
 * on top inside `TaskManager.dispatch`; this helper is for fields the
 * server itself owns (where to dial back, where `<emploke home>` lives).
 *
 * Why a dedicated module:
 *   - Keeps `index.ts` focused on Hono wiring instead of env munging.
 *   - The `0.0.0.0` → loopback rewrite has subtle platform behaviour and
 *     deserves its own dock-test surface.
 *
 * Variables emitted (all required):
 *   - EMPLOKE_SERVER  — `http://<host>:<port>`
 *   - EMPLOKE_HOME    — paths.home
 *
 * Hostname rewrite: a server bound to `0.0.0.0` accepts connections
 * on every interface, but a child dialing `0.0.0.0` is platform-
 * dependent (Windows refuses outright; *nix conventionally treats it
 * as `127.0.0.1` for outbound). Loopback is the only address
 * guaranteed to work from a same-host child, so we normalise here.
 * `::` (IPv6 wildcard) gets the same treatment for symmetry.
 */
export function buildSubprocessEnvBase(input: {
  hostname: string;
  port: number;
  home: string;
}): NodeJS.ProcessEnv {
  const dialableHost =
    input.hostname === "0.0.0.0" || input.hostname === "::" ? "127.0.0.1" : input.hostname;
  const env: NodeJS.ProcessEnv = {
    EMPLOKE_SERVER: `http://${dialableHost}:${input.port}`,
    EMPLOKE_HOME: input.home,
  };
  // Freeze: this object is shared by reference into every per-workspace
  // `TaskManager` (via `WorkspaceContextCache`) and read on every
  // `dispatch()`. A stray mutation anywhere would silently leak
  // across workspaces and across in-flight tasks. Freezing turns
  // that footgun into a loud TypeError. Callers always layer their
  // per-task additions on top via spread (`{ ...base, ... }`), which
  // creates a fresh object — that one is mutable, this base is not.
  return Object.freeze(env);
}
