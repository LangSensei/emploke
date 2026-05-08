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
 * Standard error response shape: `{ error, code? }`. The `code` field
 * carries the error class name so the dashboard can render typed UI without
 * string-matching the message.
 */
export function errorBody(err: unknown): { error: string; code?: string } {
  const error = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name) return { error, code: err.name };
  return { error };
}
