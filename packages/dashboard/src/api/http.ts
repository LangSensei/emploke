// Workspace identity + low-level fetch helpers shared by every other
// `api/*` domain module.
//
// All workspace-scoped requests are routed through `/api/workspaces/<id>/...`
// where <id> is the UUID of the active workspace. The active workspace is
// owned by the React Router URL (`/workspaces/:wsId/...`), not localStorage —
// so opening two browser tabs at different workspaces no longer makes
// them fight over a shared global. The route layout calls
// `setActiveWorkspace` on every URL change to keep this module-level slot
// in sync; api helpers below pull from it at call time so callers don't
// have to thread a workspace argument through every signature.

let activeWorkspace: string | null = null;

/** Called by the route layout whenever the URL's wsId segment changes. */
export function setActiveWorkspace(id: string | null): void {
  activeWorkspace = id;
}

/** Read the workspace currently in scope for the active route. */
export function getActiveWorkspace(): string | null {
  return activeWorkspace;
}

/**
 * Build the URL prefix for workspace-scoped resources. Throws if no
 * workspace is in scope — call sites should ensure the user is on a
 * `/workspaces/:wsId/...` route before issuing per-workspace requests.
 */
export function workspacePrefix(): string {
  if (!activeWorkspace) {
    throw new Error("no workspace selected");
  }
  return `/api/workspaces/${encodeURIComponent(activeWorkspace)}`;
}

export const fetchJson = async <T>(path: string, label: string): Promise<T> => {
  const r = await fetch(path);
  if (!r.ok) {
    throw new Error(`${label}: ${r.status}`);
  }
  return r.json() as Promise<T>;
};

/**
 * Structured error thrown by {@link mutate}, {@link mutateJson}, and
 * {@link fetchJsonWithErrorBody} on a non-OK response. Extends `Error`
 * so existing `instanceof Error` / `err.message` callers keep working
 * unchanged — the message field still carries the server-provided
 * `error` text (or the bare HTTP status as fallback).
 *
 * The extra fields let typed UI surfaces (e.g. the create-workflow
 * modal pinning a `coordinatorAgent` rejection inline next to the
 * select) branch on `code` / `field` without string-matching the
 * message. Both are present iff the server included them in the
 * structured 4xx envelope.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly field?: string;

  constructor(message: string, opts: { status: number; code?: string; field?: string }) {
    super(message);
    this.name = "ApiError";
    this.status = opts.status;
    if (opts.code !== undefined) this.code = opts.code;
    if (opts.field !== undefined) this.field = opts.field;
  }
}

/**
 * Best-effort extraction of a server-provided error message from a
 * non-OK fetch response. Falls back to the bare HTTP status if the body
 * isn't JSON or doesn't carry an `error` field. Used by both `mutate`
 * (which discards the body) and `mutateJson` (which returns the parsed
 * success body).
 */
export async function extractError(r: Response): Promise<string> {
  return (await extractErrorEnvelope(r)).message;
}

/**
 * Internal counterpart to {@link extractError} that preserves the
 * structured `code` / `field` slots from the server's 4xx envelope
 * alongside the message. Used by the `mutate*` helpers below to build
 * an {@link ApiError} that typed UI surfaces can branch on without
 * string-matching the message.
 */
async function extractErrorEnvelope(
  r: Response,
): Promise<{ message: string; code?: string; field?: string }> {
  let message = `${r.status}`;
  let code: string | undefined;
  let field: string | undefined;
  try {
    const body = await r.json();
    if (body && typeof body.error === "string") message = body.error;
    if (body && typeof body.code === "string") code = body.code;
    if (body && typeof body.field === "string") field = body.field;
  } catch {
    // body not JSON; keep status
  }
  return {
    message,
    ...(code !== undefined ? { code } : {}),
    ...(field !== undefined ? { field } : {}),
  };
}

/**
 * Build (do NOT throw) an {@link ApiError} from a non-OK fetch response.
 * Call sites use the literal `throw await buildApiError(r)` form so the
 * `throw` keyword stays textually visible in the transport — a grep for
 * `throw` over `http.ts` surfaces every error branch, instead of hiding
 * them inside a helper named `throwApiError` that returns `never`.
 */
async function buildApiError(r: Response): Promise<ApiError> {
  const { message, code, field } = await extractErrorEnvelope(r);
  return new ApiError(message, {
    status: r.status,
    ...(code !== undefined ? { code } : {}),
    ...(field !== undefined ? { field } : {}),
  });
}

export const mutate = async (path: string, init: RequestInit): Promise<void> => {
  const r = await fetch(path, init);
  if (!r.ok) throw await buildApiError(r);
};

export const mutateJson = async <T>(path: string, init: RequestInit): Promise<T> => {
  const r = await fetch(path, init);
  if (!r.ok) throw await buildApiError(r);
  return (await r.json()) as T;
};

export const jsonInit = (method: string, body: object): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Like `fetchJson` but preserves the server's error body on a non-OK
 * response. Used by `previewCron` (issue #222) so the inline preview
 * surface can render the server's "Invalid cron expression: …"
 * string verbatim rather than the generic "label: status" form.
 *
 * Accepts an optional `signal` for request cancellation; rejections
 * from an aborted fetch surface as `DOMException { name: "AbortError" }`.
 */
export async function fetchJsonWithErrorBody<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(path, signal ? { signal } : undefined);
  if (!r.ok) throw await buildApiError(r);
  return (await r.json()) as T;
}
