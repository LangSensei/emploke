/**
 * Input validators for catalog install endpoints. Pure functions
 * (no IO), thrown errors are catalog errors so the route layer can
 * map to status codes uniformly.
 *
 * Shared across HTTP / future CLI / future programmatic SDK so all
 * channels enforce the same body shape rules.
 *
 * **Wire shape**: clients send `{ origin: string }` (plus `name` for
 * MCPs is no longer needed — derived from the fetched JSON's
 * `_meta.name`). The origin URI is the canonical identity for
 * everything downstream; the wire shape and the post-validated form
 * are therefore the same shape.
 *
 * Why a single `origin` field rather than the historical
 * `{ provider, location }` pair: the origin URI **is** the canonical
 * identity in every other layer of the system (catalog DB rows,
 * AGENTS.md / SKILL.md `dependencies:` blocks, fetcher dispatch).
 * Splitting it on the wire forced two separate places to know the
 * provider list and made the wire body trivially incompatible
 * between clients (the CLI assumed `{ origin }` per the manifest
 * type, the dashboard sent `{ provider, location }` per its own
 * client-side type — server validator only accepted the latter,
 * silently bricking CLI install). Collapsing both clients onto
 * `{ origin }` removes the gap class entirely.
 *
 * The dashboard still presents a friendly `provider + location` form
 * to humans, but assembles the canonical origin URI client-side
 * before posting; see `packages/dashboard/src/api.ts`. CLI users
 * always typed an origin URI in the first place.
 *
 * Format validation (must start with `https://github.com/`,
 * `http://github.com/`, or `file:`) is delegated to `parseOrigin` in
 * `src/fetcher/origin.ts`, which owns the authoritative scheme/format
 * rules. The validator here only enforces the wire-level shape: the
 * field exists and is a non-empty string.
 */

import { AgentFrontmatterError } from "./agent/errors.js";
import { McpInvalidJsonError } from "./mcp/errors.js";
import { SkillFrontmatterError } from "./skill/errors.js";

/**
 * Resolved install body. Wire shape is identical (single `origin`
 * field), but the type alias is kept so downstream callers can
 * pattern-match against the validated form.
 */
export interface SkillInstallBody {
  readonly origin: string;
}

export interface AgentInstallBody {
  readonly origin: string;
}

export interface McpInstallBody {
  readonly origin: string;
}

const REQUEST_PATH = "<request>";

/**
 * Validate the body of `POST /catalog/skills`. Throws on shape
 * violations; the route layer maps to HTTP 400.
 */
export function validateSkillInstallInput(raw: unknown): SkillInstallBody {
  const obj = expectObject(raw, "skill");
  return { origin: requireOrigin(obj, "skill") };
}

/** Validate the body of `POST /catalog/agents`. Same shape as skills. */
export function validateAgentInstallInput(raw: unknown): AgentInstallBody {
  const obj = expectObject(raw, "agent");
  return { origin: requireOrigin(obj, "agent") };
}

/**
 * Validate the body of `POST /catalog/mcps`. Same shape as skills /
 * agents — `name` is derived from the fetched JSON's `_meta.name`
 * field at install time, not from the request body.
 */
export function validateMcpInstallInput(raw: unknown): McpInstallBody {
  const obj = expectObject(raw, "mcp");
  return { origin: requireOrigin(obj, "mcp") };
}

function requireOrigin(obj: Record<string, unknown>, kind: "skill" | "agent" | "mcp"): string {
  const origin = requireNonEmptyString(obj, "origin", kind);
  return origin.trim();
}

function expectObject(raw: unknown, kind: "skill" | "agent" | "mcp"): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw kindError(kind, "request body must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

function requireNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  kind: "skill" | "agent" | "mcp",
): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw kindError(kind, `\`${key}\` is required and must be a non-empty string`);
  }
  return v;
}

function kindError(kind: "skill" | "agent" | "mcp", reason: string): Error {
  if (kind === "skill") return new SkillFrontmatterError(REQUEST_PATH, reason);
  if (kind === "agent") return new AgentFrontmatterError(REQUEST_PATH, reason);
  return new McpInvalidJsonError(REQUEST_PATH, reason);
}
