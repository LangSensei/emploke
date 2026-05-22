import type { Context } from "hono";
import type { Logger } from "pino";

/**
 * Parse a JSON request body. Returns either the parsed value or an error
 * shape suitable for a 400 response. Caller validates the body further.
 */
export async function parseJsonBody<T = unknown>(
  c: Context,
): Promise<{ ok: true; body: T } | { ok: false; error: string }> {
  try {
    const body = (await c.req.json()) as T;
    return { ok: true, body };
  } catch {
    return { ok: false, error: "request body must be JSON" };
  }
}

/**
 * Allow-list of error class `name`s whose `.message` is safe to surface in
 * an HTTP response body. Each entry is a typed error from an emploke
 * package whose message is intentionally user-facing (no host paths, no
 * caller-controlled echoes, no Node `fs` error strings — kind / identifier
 * only).
 *
 * Anything outside this list — generic `Error`, `EACCES`/`ENOENT` from
 * the filesystem, syntax errors, third-party errors — collapses to a
 * generic "internal error" to avoid leaking host paths or implementation
 * details (e.g. `EACCES: permission denied, open '/etc/shadow'`).
 *
 * Adding a new error class? Audit its `super(...)` template before
 * adding it here:
 *   - no absolute paths (`workdir`, `sessionDir`, `taskDir`, …)
 *   - no `cause.message` interpolated in (Node fs error strings,
 *     third-party stack lines)
 *   - no caller-controlled string echoed back without validation
 * Keep the diagnostic on the instance (public fields + `cause`) so the
 * route can `c.get("logger").error({ err, ... })` it;
 * just don't bake it into `.message`.
 */
const SAFE_ERROR_NAMES = new Set<string>([
  // @emploke/catalog
  // Real instances only — the catalog never throws an instance of the
  // abstract `CatalogError` base class, and previous entries
  // (`CatalogStateError`, `CycleDetected`, `MissingDependencies`,
  // `UnsupportedCatalogVersionError`) named classes that don't exist
  // in the codebase. Adding speculative names here would mask future
  // typos: an entry on this list looks intentional even when the
  // referenced class never gets thrown. Update by grepping
  // `^export class \w+Error` in `packages/catalog/src/**`.
  "FetchError",
  "AgentFrontmatterError",
  "SkillFrontmatterError",
  "CyclicDependencyError",
  "HasDependentsError",
  "ImmutableOriginError",
  "McpInvalidJsonError",
  "McpNameInvalidError",
  "SkillNameInvalidError",
  "AgentNameInvalidError",
  "SkillNotFoundError",
  "AgentNotFoundError",
  "McpNotFoundError",
  "SkillOriginConflictError",
  "AgentOriginConflictError",
  "McpOriginConflictError",
  "OriginParseError",
  "PlanStaleError",
  "AgentPlanStaleError",
  "RuntimeDoesNotSupportRemoteError",
  // @emploke/session
  "AgentNotFoundError",
  "InvalidSessionIdError",
  "SessionIdAllocationFailedError",
  "SessionNotFoundError",
  "SessionError",
  // @emploke/runtime
  "InvalidMcpJson",
  "RuntimeHeadlessLaunchFailed",
  "RuntimeProvisionFailed",
  "RuntimeRefreshFailed",
  "RuntimeStateDeletionFailed",
  "UnknownRuntimeError",
  "TrustRegistrationFailed",
  // @emploke/task
  "CorruptedTaskError",
  "InvalidTaskIdError",
  "TaskNotFoundError",
  "TaskIdAllocationFailedError",
  "RuntimeDoesNotSupportTasksError",
  "EntryNotReadyError",
  "TaskError",
  "InvalidTransition",
  "ManagerShuttingDownError",
  // @emploke/terminal (surface via /:id/spawn)
  "NoTerminalFoundError",
  "TerminalSpawnFailedError",
  "UnsupportedPlatformError",
  // @emploke/server (cache-eviction conflicts)
  "WorkspaceHasLiveTasksError",
  // @emploke/workspace
  "RegistryError",
  "WorkspaceError",
  "WorkspaceIdConflictError",
  "WorkspaceIdInvalidError",
  "WorkspaceNameInvalidError",
  "WorkspaceNotRegisteredError",
  "WorkspacePathConflictError",
]);

/**
 * Log a server-side fault via the request-scoped logger. Drop-in
 * replacement for the previous `logServerError` helper, except now the
 * line lands in the rotated JSON file (`<emplokeHome>/logs/server-*.log`)
 * via pino instead of going to `console.error` only — closing the
 * file/stderr divergence that issue #58 called out.
 *
 * Reads `c.var.logger` (set by `requestLogger` middleware in `index.ts`)
 * and falls through silently when no logger is on the context (e.g.
 * tests that mount routes standalone). Returns void.
 *
 * Usage in route catch blocks:
 *
 *     } catch (err) {
 *       const status = statusForError(err) ?? 400;
 *       if (status >= 500) logFault(c, err, "session.create failed");
 *       return c.json(errorBody(err), status as any);
 *     }
 */
export function logFault(
  c: Context,
  err: unknown,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  // Cast widens the no-Variables `Context` type so we can probe for
  // the request-scoped logger without forcing every route factory to
  // declare a `Variables: { logger: Logger }` env up-front. The check
  // below returns silently when the logger isn't present.
  const logger = (c.get as unknown as (k: string) => unknown)("logger") as Logger | undefined;
  if (logger === undefined) return;
  logger.error({ err, ...(extra ?? {}) }, msg);
}

/**
 * Companion to {@link logFault} for state-mutating routes' success
 * boundary. Emits a single `info`-level structured line via the
 * request-scoped logger so operators can `jq 'select(.msg=="...")'`
 * audit who changed what.
 *
 * Same context-probe pattern as `logFault` (silent no-op when no
 * logger is on `c.var`, e.g. unit tests that mount a route factory
 * directly without the middleware chain). Routes typically call this
 * AFTER the manager call returns and BEFORE the JSON response is
 * built, so a 5xx in serialisation still leaves the audit line.
 *
 * Convention for `meta`: include the entity id (`sessionId` /
 * `taskId` / `workspaceId` / `fqn`), the action verb if the message
 * doesn't already carry it, and any user-supplied input that's safe
 * to log (NEVER request bodies / passwords / tokens — keep it to
 * structured fields the entity already exposes).
 */
export function logEvent(c: Context, msg: string, meta?: Record<string, unknown>): void {
  const logger = (c.get as unknown as (k: string) => unknown)("logger") as Logger | undefined;
  if (logger === undefined) return;
  logger.info(meta ?? {}, msg);
}

/**
 * Standard error response shape: `{ error, code? }`. The `code` field
 * carries the error class name so the dashboard can render typed UI without
 * string-matching the message.
 *
 * Errors NOT in `SAFE_ERROR_NAMES` are flattened to `"internal error"` so
 * that filesystem error messages, third-party stack traces, and
 * caller-controlled echoes never reach the client. Routes that map a
 * specific typed error to a specific HTTP status before calling this
 * helper still get the original message + code.
 */
export function errorBody(err: unknown): { error: string; code?: string } {
  if (err instanceof Error && SAFE_ERROR_NAMES.has(err.name)) {
    return { error: err.message, code: err.name };
  }
  return { error: "internal error" };
}

/**
 * Map an error from the catalog layer to an HTTP status code:
 *   - `*NameInvalidError` / `*FrontmatterError` / `McpInvalidJsonError` /
 *     `OriginParseError` / `PlanStaleError` → 400 (caller-fixable input)
 *   - `*NotFoundError` → 404
 *   - `HasDependentsError` / `*OriginConflictError` → 409 (state conflict)
 *   - `ImmutableOriginError` → 405 (mutation against a read-only origin)
 *   - `FetchError` → 502 (downstream fetch failed; sanitised body)
 *   - everything else → 500 (server fault, paired with `errorBody` →
 *     `"internal error"` so internals don't leak)
 *
 * Returns null when the error class is unrecognised; callers should treat
 * that as 500.
 *
 * **Important**: cases below MUST use the real per-entity class names
 * (`SkillNotFoundError`, not the alias `NotFound`). The catalog's
 * abstract base error class sets `this.name = new.target.name`, so an
 * `instanceof SkillNotFoundError` thrown by service code carries
 * `.name === "SkillNotFoundError"`. A switch on the alias would never
 * match and every error would fall through to 500. The unit suite in
 * `test/error-sanitization.test.ts` exercises this with real instances.
 */
export function statusForCatalogError(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  switch (err.name) {
    case "SkillNameInvalidError":
    case "AgentNameInvalidError":
    case "McpNameInvalidError":
    case "AgentFrontmatterError":
    case "SkillFrontmatterError":
    case "McpInvalidJsonError":
    case "OriginParseError":
    case "PlanStaleError":
    case "AgentPlanStaleError":
    case "CyclicDependencyError":
      return 400;
    case "SkillNotFoundError":
    case "AgentNotFoundError":
    case "McpNotFoundError":
      return 404;
    case "HasDependentsError":
    case "SkillOriginConflictError":
    case "AgentOriginConflictError":
    case "McpOriginConflictError":
      return 409;
    case "ImmutableOriginError":
      return 405;
    case "FetchError":
      return 502;
    default:
      return null;
  }
}
