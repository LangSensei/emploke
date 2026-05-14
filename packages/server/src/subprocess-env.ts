/**
 * Builds the static portion of the env bag that the server hands to
 * every emploke-spawned subprocess. Per-run additions
 * (`EMPLOKE_WORKSPACE`, `EMPLOKE_WORKSPACE_DIR`, `EMPLOKE_WORK_*`) are
 * layered on top inside `TaskManager.dispatch` /
 * `SessionManager.assembleLaunchEnv`; this helper is for fields the
 * server itself owns (where to dial back, where the cross-workspace
 * shared state directory lives).
 *
 * Why a dedicated module:
 *   - Keeps `index.ts` focused on Hono wiring instead of env munging.
 *   - The `0.0.0.0` → loopback rewrite has subtle platform behaviour and
 *     deserves its own dock-test surface.
 *
 * Variables emitted (all required):
 *   - EMPLOKE_SERVER     — `http://<host>:<port>`
 *   - EMPLOKE_SHARED_DIR — `<EMPLOKE_HOME>/shared`, the canonical
 *                         cross-workspace state directory. Same path
 *                         the runtime exposes to MCP specs as
 *                         `${sharedDir}`. Agents and skills that need
 *                         "machine-shared writable state" (playwright
 *                         logins re-used across workspaces, model
 *                         caches, …) read this. The service-internal
 *                         `<EMPLOKE_HOME>` itself (which holds
 *                         `global.db`, `runtime.json`, `logs/`) is
 *                         deliberately NOT exposed — agents have no
 *                         business touching it.
 *
 * Hostname rewrite: a server bound to `0.0.0.0` accepts connections
 * on every interface, but a child dialing `0.0.0.0` is platform-
 * dependent (Windows refuses outright; *nix conventionally treats it
 * as `127.0.0.1` for outbound). Loopback is the only address
 * guaranteed to work from a same-host child, so we normalise here.
 * `::` (IPv6 wildcard) gets the same treatment for symmetry.
 *
 * No auth env: emploke ships no auth layer (the server binds loopback-
 * only; remote access is delegated to SSH / reverse proxy / mesh VPN).
 * There is therefore no `EMPLOKE_API_KEY` and no analogue.
 */
export function buildSubprocessEnvBase(input: {
  hostname: string;
  port: number;
  sharedDir: string;
}): NodeJS.ProcessEnv {
  const dialableHost =
    input.hostname === "0.0.0.0" || input.hostname === "::" ? "127.0.0.1" : input.hostname;
  const env: NodeJS.ProcessEnv = {
    EMPLOKE_SERVER: `http://${dialableHost}:${input.port}`,
    EMPLOKE_SHARED_DIR: input.sharedDir,
    // EXPLICIT NEGATIVE: scrub `EMPLOKE_HOME` from every spawned
    // task subprocess. The server itself reads `process.env.EMPLOKE_HOME`
    // to find its own state directory, so the value is in the parent
    // env by construction. Without this `undefined` the spawn's env
    // inheritance would leak the path through, contradicting the
    // public contract (see docs/architecture.md "Runtime env
    // contract"). The task path goes through `mergeEnv` in
    // `packages/runtime/src/copilot/launch-headless.ts`, which
    // honours `undefined` as "delete this key from the parent env".
    //
    // The session-interactive path (`SessionManager.assembleLaunchEnv`)
    // intentionally filters `undefined` values out before reaching
    // the terminal-side shell-env helpers, so the parent's
    // `EMPLOKE_HOME` leaks through ambient inheritance — that's by
    // design, see "Deliberately not exposed" in architecture.md:
    // user-driven terminals own their shell state.
    EMPLOKE_HOME: undefined,
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
