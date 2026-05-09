import {
  type AgentInstallBody,
  type McpInstallBody,
  type SkillInstallBody,
  validateAgentInstallInput,
  validateMcpInstallInput,
  validateSkillInstallInput,
} from "@emploke/catalog";
import type { Context } from "hono";
import { parseJsonBody } from "../_shared.js";

/**
 * Per-route input parsers. Thin adapter around the catalog package's
 * pure validators (`@emploke/catalog/install-input.ts`):
 *  - parse JSON body
 *  - delegate validation to catalog
 *  - convert thrown {@link FrontmatterError} / {@link McpNameInvalidError}
 *    into the route's `{ error }` shape (callers map to 400)
 *
 * All semantic validation (required fields, scope grammar, MCP name shape)
 * lives in the catalog so HTTP / future CLI / SDK share one source of truth.
 */

/** POST /catalog/skills body: `{ origin: string, scopeHints?: { fqn: scope } }`. */
export async function readSkillInstallBody(
  c: Context,
): Promise<SkillInstallBody | { error: string }> {
  const parsed = await parseJsonBody<unknown>(c);
  if (!parsed.ok) return { error: parsed.error };
  try {
    return validateSkillInstallInput(parsed.body);
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** POST /catalog/agents body — same shape as skills. */
export async function readAgentInstallBody(
  c: Context,
): Promise<AgentInstallBody | { error: string }> {
  const parsed = await parseJsonBody<unknown>(c);
  if (!parsed.ok) return { error: parsed.error };
  try {
    return validateAgentInstallInput(parsed.body);
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * POST /catalog/mcps body: `{ origin: string, name: string }`. `name` is
 * the full MCP-spec FQN (`<namespace>/<short>`). MCPs don't take
 * `scopeHints` — spec name IS the catalog identity.
 */
export async function readMcpInstallBody(c: Context): Promise<McpInstallBody | { error: string }> {
  const parsed = await parseJsonBody<unknown>(c);
  if (!parsed.ok) return { error: parsed.error };
  try {
    return validateMcpInstallInput(parsed.body);
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** PUT body for updating a resource's content: `{ content: string }`. */
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
