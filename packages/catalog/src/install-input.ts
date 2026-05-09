/**
 * Input validators for catalog install endpoints. Pure functions
 * (no IO), thrown errors are CatalogErrors so the route layer can
 * map to status codes uniformly.
 *
 * The HTTP-adapter layer (`server/src/routes/catalog/helpers.ts`)
 * parses the JSON body and calls the appropriate validator; all
 * validation logic lives here so we have a single source of truth
 * shared across HTTP, future CLI, future programmatic SDK.
 */
import { FrontmatterError } from "./errors.js";
import { validateMcpName, validateScope } from "./validate.js";

export interface SkillInstallBody {
  readonly origin: string;
  readonly scopeHints?: Readonly<Record<string, string>>;
}

export interface AgentInstallBody {
  readonly origin: string;
  readonly scopeHints?: Readonly<Record<string, string>>;
}

export interface McpInstallBody {
  readonly origin: string;
  readonly name: string;
}

const REQUEST_PATH = "<request>";

/**
 * Validate the body of `POST /catalog/skills`. Throws
 * {@link FrontmatterError} on shape violations (route maps to 400).
 */
export function validateSkillInstallInput(raw: unknown): SkillInstallBody {
  const obj = expectObject(raw);
  return {
    origin: requireNonEmptyString(obj, "origin"),
    ...(obj.scopeHints !== undefined ? { scopeHints: validateScopeHints(obj.scopeHints) } : {}),
  };
}

/** Validate the body of `POST /catalog/agents`. Same shape as skills. */
export function validateAgentInstallInput(raw: unknown): AgentInstallBody {
  const obj = expectObject(raw);
  return {
    origin: requireNonEmptyString(obj, "origin"),
    ...(obj.scopeHints !== undefined ? { scopeHints: validateScopeHints(obj.scopeHints) } : {}),
  };
}

/**
 * Validate the body of `POST /catalog/mcps`. MCPs require both
 * `origin` and `name` (the spec FQN); they don't take `scopeHints`
 * because MCPs don't participate in emploke's scope-mapping system.
 */
export function validateMcpInstallInput(raw: unknown): McpInstallBody {
  const obj = expectObject(raw);
  const origin = requireNonEmptyString(obj, "origin");
  const name = requireNonEmptyString(obj, "name");
  validateMcpName(name);
  return { origin, name };
}

function expectObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FrontmatterError(REQUEST_PATH, "request body must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

function requireNonEmptyString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new FrontmatterError(REQUEST_PATH, `\`${key}\` is required and must be a non-empty string`);
  }
  return v;
}

function validateScopeHints(raw: unknown): Readonly<Record<string, string>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FrontmatterError(REQUEST_PATH, "`scopeHints` must be a JSON object");
  }
  const out: Record<string, string> = {};
  for (const [fqn, scope] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof scope !== "string" || scope.length === 0) {
      throw new FrontmatterError(
        REQUEST_PATH,
        `\`scopeHints[${JSON.stringify(fqn)}]\` must be a non-empty string`,
      );
    }
    validateScope(scope);
    out[fqn] = scope;
  }
  return out;
}
