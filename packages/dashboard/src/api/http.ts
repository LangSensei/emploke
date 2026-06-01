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
 * Best-effort extraction of a server-provided error message from a
 * non-OK fetch response. Falls back to the bare HTTP status if the body
 * isn't JSON or doesn't carry an `error` field. Used by both `mutate`
 * (which discards the body) and `mutateJson` (which returns the parsed
 * success body).
 */
export async function extractError(r: Response): Promise<string> {
  let msg = `${r.status}`;
  try {
    const body = await r.json();
    if (body && typeof body.error === "string") msg = body.error;
  } catch {
    // body not JSON; keep status
  }
  return msg;
}

export const mutate = async (path: string, init: RequestInit): Promise<void> => {
  const r = await fetch(path, init);
  if (!r.ok) throw new Error(await extractError(r));
};

export const mutateJson = async <T>(path: string, init: RequestInit): Promise<T> => {
  const r = await fetch(path, init);
  if (!r.ok) throw new Error(await extractError(r));
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
  if (!r.ok) throw new Error(await extractError(r));
  return (await r.json()) as T;
}
