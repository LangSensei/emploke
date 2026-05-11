/**
 * Input validators for catalog install endpoints. Pure functions
 * (no IO), thrown errors are catalog errors so the route layer can
 * map to status codes uniformly.
 *
 * Shared across HTTP / future CLI / future programmatic SDK so all
 * channels enforce the same body shape rules.
 *
 * **Wire shape**: clients send `{ provider, location }` (plus `name`
 * for MCPs). The validator assembles the canonical origin URI from
 * those structured fields so callers don't compose URI strings client-
 * side. The downstream catalog facade only ever sees the origin URI;
 * provider is purely a wire-side concern.
 *
 * Adding a new provider (e.g. `"npm"`, `"oci"`) means:
 *   1. extending the `InstallProvider` type
 *   2. adding a case to {@link buildOriginFrom}
 * No catalog-internal change required.
 */

import { AgentFrontmatterError } from "../agent/errors.js";
import { McpInvalidJsonError } from "../mcp/errors.js";
import { SkillFrontmatterError } from "../skill/errors.js";

export type InstallProvider = "github" | "file";

const PROVIDERS: ReadonlySet<string> = new Set<InstallProvider>(["github", "file"]);

/**
 * Resolved install body. Routes consume this; the wire-side
 * `provider`/`location` pair is intentionally not exposed past the
 * validator — once we've assembled an origin URI, it IS the identity.
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
 * Validate the body of `POST /catalog/mcps`. MCPs only need
 * `provider`+`location` — name is derived from the fetched JSON's
 * `_meta.name` field at install time.
 */
export function validateMcpInstallInput(raw: unknown): McpInstallBody {
  const obj = expectObject(raw, "mcp");
  return { origin: requireOrigin(obj, "mcp") };
}

function requireOrigin(obj: Record<string, unknown>, kind: "skill" | "agent" | "mcp"): string {
  const provider = requireNonEmptyString(obj, "provider", kind);
  if (!PROVIDERS.has(provider)) {
    throw kindError(
      kind,
      `\`provider\` must be one of: ${[...PROVIDERS].join(", ")} (got "${provider}")`,
    );
  }
  const location = requireNonEmptyString(obj, "location", kind);
  return buildOriginFrom(provider as InstallProvider, location);
}

/**
 * Assemble a canonical origin URI from the wire-side provider+location
 * pair. Kept separate so non-HTTP callers (e.g. CLI) can reuse it
 * without re-implementing the dispatch table.
 *
 *   - `github` + `https://github.com/owner/repo/tree/ref/path` →
 *     pass-through (the URL is already the canonical github origin)
 *   - `file`   + `/abs/path`            → `file:/abs/path`
 *   - `file`   + `file:/abs/path`       → `file:/abs/path` (tolerate
 *     paste with prefix; trim and re-emit)
 */
export function buildOriginFrom(provider: InstallProvider, location: string): string {
  const trimmed = location.trim();
  switch (provider) {
    case "github":
      return trimmed;
    case "file":
      return trimmed.startsWith("file:") ? trimmed : `file:${trimmed}`;
  }
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
