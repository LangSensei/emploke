/**
 * Input validators for catalog install endpoints. Pure functions
 * (no IO), thrown errors are catalog errors so the route layer can
 * map to status codes uniformly.
 *
 * Shared across HTTP / future CLI / future programmatic SDK so all
 * channels enforce the same body shape rules.
 */

import { AgentFrontmatterError } from "../agent/errors.js";
import { McpInvalidJsonError } from "../mcp/errors.js";
import { validateMcpName } from "../mcp/validate.js";
import { SkillFrontmatterError } from "../skill/errors.js";

export interface SkillInstallBody {
  readonly origin: string;
}

export interface AgentInstallBody {
  readonly origin: string;
}

export interface McpInstallBody {
  readonly origin: string;
  readonly name: string;
}

const REQUEST_PATH = "<request>";

/**
 * Validate the body of `POST /catalog/skills`. Throws on shape
 * violations; the route layer maps to HTTP 400.
 */
export function validateSkillInstallInput(raw: unknown): SkillInstallBody {
  const obj = expectObject(raw, "skill");
  return { origin: requireNonEmptyString(obj, "origin", "skill") };
}

/** Validate the body of `POST /catalog/agents`. Same shape as skills. */
export function validateAgentInstallInput(raw: unknown): AgentInstallBody {
  const obj = expectObject(raw, "agent");
  return { origin: requireNonEmptyString(obj, "origin", "agent") };
}

/**
 * Validate the body of `POST /catalog/mcps`. MCPs require both
 * `origin` and `name` (the spec FQN).
 */
export function validateMcpInstallInput(raw: unknown): McpInstallBody {
  const obj = expectObject(raw, "mcp");
  const origin = requireNonEmptyString(obj, "origin", "mcp");
  const name = requireNonEmptyString(obj, "name", "mcp");
  validateMcpName(name);
  return { origin, name };
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
