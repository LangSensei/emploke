import type { Context } from "hono";
import { parseJsonBody } from "../_shared.js";

interface InstallBody {
  origin?: unknown;
  name?: unknown;
  scope?: unknown;
}

/**
 * POST /catalog/skills body: `{ origin: string }`. Skills derive name from
 * their SKILL.md frontmatter, so no `name` field is accepted (avoids the
 * confusion of "I sent name=foo but the frontmatter said bar; which won?").
 */
export async function readSkillInstallBody(
  c: Context,
): Promise<{ origin: string } | { error: string }> {
  const parsed = await parseJsonBody<InstallBody>(c);
  if (!parsed.ok) return { error: parsed.error };
  const body = parsed.body;
  if (typeof body.origin !== "string" || body.origin.trim() === "") {
    return { error: "origin is required (string)" };
  }
  return { origin: body.origin };
}

/**
 * POST /catalog/agents body: `{ origin: string }`. Same shape as skills;
 * name comes from AGENTS.md frontmatter.
 */
export async function readAgentInstallBody(
  c: Context,
): Promise<{ origin: string } | { error: string }> {
  return readSkillInstallBody(c); // same shape
}

/**
 * POST /catalog/mcps body: `{ origin: string, name: string, scope?: string }`.
 *
 * `name` is REQUIRED (unlike skills/agents) because MCPs have no
 * frontmatter — the catalog has nothing else to derive the short name
 * from. The previous "default to basename(origin)" rule was a foot-gun:
 * MCP files on GitHub are often called generic things like `mcp.json` or
 * `config.json`, leading to surprising FQNs and silent conflicts.
 *
 * `scope` is an optional override; the default is `scopeFromOrigin(origin)`
 * (e.g. `anthropic` for a `https://github.com/anthropic/...` origin).
 *
 * Provenance: the server records `{ origin, name, scope }` in a sidecar
 * (`<name>.origin.json`) next to the MCP JSON, so a future Phase-2
 * "refresh from upstream" path can re-fetch without the client re-supplying
 * the origin. The dashboard surfaces the sidecar's origin in the MCP
 * detail view.
 */
export async function readMcpInstallBody(
  c: Context,
): Promise<{ origin: string; name: string; scope?: string } | { error: string }> {
  const parsed = await parseJsonBody<InstallBody>(c);
  if (!parsed.ok) return { error: parsed.error };
  const body = parsed.body;
  if (typeof body.origin !== "string" || body.origin.trim() === "") {
    return { error: "origin is required (string)" };
  }
  if (typeof body.name !== "string" || body.name.trim() === "") {
    return {
      error:
        "name is required (string) — MCPs have no frontmatter, so the short name must be supplied explicitly",
    };
  }
  const out: { origin: string; name: string; scope?: string } = {
    origin: body.origin,
    name: body.name,
  };
  if (typeof body.scope === "string" && body.scope.trim() !== "") {
    out.scope = body.scope;
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
