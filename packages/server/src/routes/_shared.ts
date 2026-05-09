import type { Context } from "hono";

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
 * package whose message is intentionally user-facing (no file paths,
 * stack traces, or internal state).
 *
 * Anything outside this list — generic `Error`, `EACCES`/`ENOENT` from
 * the filesystem, syntax errors, third-party errors — collapses to a
 * generic "internal error" to avoid leaking host paths or implementation
 * details (e.g. `EACCES: permission denied, open '/etc/shadow'`).
 *
 * Adding a new error class? Make sure its `.message` is sanitised
 * (no host paths, no caller-controlled data echoed back without
 * validation) before adding it here.
 */
const SAFE_ERROR_NAMES = new Set<string>([
  // @emploke/catalog
  "CatalogError",
  "CatalogStateError",
  "CycleDetected",
  "FrontmatterError",
  "HasDependents",
  "MissingDependencies",
  "NameInvalid",
  "NotFound",
  // @emploke/session
  "AgentNotFoundError",
  "InvalidSessionIdError",
  "SessionCorruptedError",
  "SessionIdAllocationFailedError",
  "SessionNotFoundError",
  "SessionsError",
  // @emploke/runtime
  "InvalidMcpJson",
  "RuntimeDispatchTaskFailed",
  "RuntimeProvisionFailed",
  "RuntimeRefreshFailed",
  "RuntimeStateDeletionFailed",
  "UnknownRuntimeError",
  "TrustRegistrationFailed",
  "WorkdirPrepFailed",
  // @emploke/task
  "InvalidTaskIdError",
  "TaskNotFoundError",
  "TaskIdAllocationFailedError",
  "RuntimeDoesNotSupportTasksError",
  "TaskError",
  "InvalidTransition",
  // @emploke/terminal (surface via /:id/spawn)
  "NoTerminalFoundError",
  "TerminalSpawnFailedError",
  "UnsupportedPlatformError",
  // @emploke/workspace
  "RegistryCorruptedError",
  "RegistryError",
  "WorkspaceAlreadyExistsError",
  "WorkspaceCorruptedError",
  "WorkspaceError",
  "WorkspaceIdConflictError",
  "WorkspaceIdInvalidError",
  "WorkspaceNameInvalidError",
  "WorkspaceNotFoundError",
  "WorkspaceNotRegisteredError",
  "WorkspacePathConflictError",
  "WorkspaceSchemaMismatchError",
]);

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
 *   - `NameInvalid` / `FrontmatterError` / `MissingDependencies` /
 *     `CycleDetected` → 400 (caller-fixable input)
 *   - `NotFound` → 404
 *   - `HasDependents` → 409 (state conflict)
 *   - everything else → 500 (server fault, paired with `errorBody` →
 *     `"internal error"` so internals don't leak)
 *
 * Returns null when the error class is unrecognised; callers should treat
 * that as 500.
 */
export function statusForCatalogError(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  switch (err.name) {
    case "NameInvalid":
    case "FrontmatterError":
    case "MissingDependencies":
    case "CycleDetected":
      return 400;
    case "NotFound":
      return 404;
    case "HasDependents":
      return 409;
    default:
      return null;
  }
}
