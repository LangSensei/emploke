/**
 * Builds the static portion of the env bag that the server hands to
 * every emploke-spawned subprocess. Per-run additions
 * (`EMPLOKE_WORKSPACE`, `EMPLOKE_WORKSPACE_DIR`, `EMPLOKE_WORK_*`) are
 * layered on top inside `TaskService.dispatch` /
 * `SessionService.assembleLaunchEnv`; this helper is for fields the
 * server itself owns (where to dial back, where the cross-workspace
 * shared state directory lives).
 *
 * Why a dedicated module:
 *   - Keeps `index.ts` focused on Hono wiring instead of env munging.
 *   - The `0.0.0.0` → loopback rewrite has subtle platform behaviour and
 *     deserves its own dock-test surface.
 *
 * Variables emitted (all required, all string-typed):
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
 *                         business touching it. See
 *                         {@link SUBPROCESS_ENV_SCRUB_KEYS} for the
 *                         enforcement seam on the headless path.
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
}): Readonly<Record<string, string>> {
  const dialableHost =
    input.hostname === "0.0.0.0" || input.hostname === "::" ? "127.0.0.1" : input.hostname;
  // Freeze: this object is shared by reference into every per-workspace
  // `CopilotRuntime` (via the bootstrap-time wiring) and read on every
  // `launchHeadless` / `buildInteractiveLaunch`. A stray mutation
  // anywhere would silently leak across workspaces and across in-flight
  // launches. Freezing turns that footgun into a loud TypeError.
  // Callers always layer their per-task additions on top via spread
  // (`{ ...base, ... }`), which creates a fresh object — that one is
  // mutable, this base is not.
  return Object.freeze({
    EMPLOKE_SERVER: `http://${dialableHost}:${input.port}`,
    EMPLOKE_SHARED_DIR: input.sharedDir,
  });
}

/**
 * Env keys that the headless launch path MUST strip from the
 * inherited parent env before handing the child to the SDK. Distinct
 * from {@link buildSubprocessEnvBase} because "set X to Y" and
 * "remove X" are different semantics and only one of them is
 * actionable on every launch path.
 *
 * `EMPLOKE_HOME`: the server reads `process.env.EMPLOKE_HOME` to find
 * its own state directory, so the value is in the server's env by
 * construction. Without an explicit scrub, every spawned task would
 * inherit it and could reach into `global.db`, `runtime.json`,
 * `logs/`, etc. — exactly what `EMPLOKE_SHARED_DIR` was designed to
 * replace. The headless path goes through `mergeEnv` in
 * `packages/runtime/src/copilot/launch-headless.ts`, which honours an
 * `undefined` override as "delete this key from the parent env";
 * `CopilotRuntime.launchHeadless` translates this list into those
 * overrides.
 *
 * Interactive (session-spawned terminal) launches deliberately do NOT
 * apply this scrub: a user-driven shell owns its own env. `cmd /k`
 * and pwsh `$env:` prefixes can only SET values, not unset them, so
 * there is no way to delete an inherited key from inside the shell
 * launcher anyway. See "Deliberately not exposed" in
 * `docs/architecture.md` for the contract.
 */
export const SUBPROCESS_ENV_SCRUB_KEYS: readonly string[] = Object.freeze(["EMPLOKE_HOME"]);
