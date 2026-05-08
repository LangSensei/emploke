import type { Context } from "hono";
import { parseJsonBody } from "../_shared.js";

interface InstallBody {
  sourcePath?: unknown;
  name?: unknown;
}

/**
 * POST /install body shape used by skills, agents, and mcps:
 * `{ sourcePath: string, name?: string }`. Returns either the parsed
 * fields or an `{ error }` shape suitable for a 400 response.
 */
export async function readInstallBody(
  c: Context,
): Promise<{ sourcePath: string; name?: string } | { error: string }> {
  const parsed = await parseJsonBody<InstallBody>(c);
  if (!parsed.ok) return { error: parsed.error };
  const body = parsed.body;
  if (typeof body.sourcePath !== "string" || body.sourcePath.trim() === "") {
    return { error: "sourcePath is required (string)" };
  }
  const out: { sourcePath: string; name?: string } = { sourcePath: body.sourcePath };
  if (typeof body.name === "string" && body.name.trim() !== "") {
    out.name = body.name;
  }
  return out;
}

/**
 * PUT body for updating a resource's content: `{ content: string }`.
 */
export async function readContentBody(
  c: Context,
): Promise<{ content: string } | { error: string }> {
  const parsed = await parseJsonBody<{ content?: unknown }>(c);
  if (!parsed.ok) return { error: parsed.error };
  if (typeof parsed.body.content !== "string") {
    return { error: "body must be { content: string }" };
  }
  return { content: parsed.body.content };
}

/**
 * PATCH body for updating resource metadata: any JSON object. Field-level
 * validation is delegated to the catalog layer.
 */
export async function readMetadataBody(
  c: Context,
): Promise<{ body: Record<string, unknown> } | { error: string }> {
  const parsed = await parseJsonBody<unknown>(c);
  if (!parsed.ok) return { error: parsed.error };
  if (typeof parsed.body !== "object" || parsed.body === null) {
    return { error: "body must be a JSON object" };
  }
  return { body: parsed.body as Record<string, unknown> };
}
