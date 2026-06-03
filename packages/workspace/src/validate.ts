import path from "node:path";
import { z } from "zod";
import { WorkspaceIdInvalidError, WorkspaceNameInvalidError } from "./errors.js";

/**
 * Validation helpers for workspace inputs.
 *
 * Plain functions that validate raw input strings against the
 * API-contract rules. `WorkspaceService` calls them at its boundary;
 * the repository trusts whatever the service hands it.
 */

/** RFC-4122 UUID. Accept any version; we mint v4 but external sources may differ. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_DISPLAY_NAME_LENGTH = 64;
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control chars in user input is the point.
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

export function isValidWorkspaceId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

export function assertValidWorkspaceId(id: unknown): asserts id is string {
  if (!isValidWorkspaceId(id)) {
    throw new WorkspaceIdInvalidError(typeof id === "string" ? id : String(id));
  }
}

export function assertValidWorkspaceName(name: unknown): asserts name is string {
  if (typeof name !== "string") {
    throw new WorkspaceNameInvalidError(String(name), "must be a string");
  }
  if (name.trim().length === 0) {
    throw new WorkspaceNameInvalidError(name, "must be non-empty after trim");
  }
  if (name.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new WorkspaceNameInvalidError(
      name,
      `must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
    );
  }
  if (CONTROL_CHAR_RE.test(name)) {
    throw new WorkspaceNameInvalidError(name, "must not contain control characters");
  }
}

export function isValidWorkspaceName(name: unknown): name is string {
  try {
    assertValidWorkspaceName(name);
    return true;
  } catch {
    return false;
  }
}

/** Resolve to absolute. Throws on empty / non-string. */
export function normalizeWorkspaceDir(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`workspaceDir must be a non-empty string, got ${String(value)}`);
  }
  return path.resolve(value);
}

// ─── Zod schema (presence + types; plus workspaceDir-must-be-absolute) ──

export const RegisterWorkspaceInput = z.object({
  id: z.string(),
  // Length cap lives in `assertValidWorkspaceName` (MAX_DISPLAY_NAME_LENGTH).
  // We don't repeat it here so over-length names surface as the typed
  // `WorkspaceNameInvalidError` (with context), not as a generic
  // `InputValidationError` from a duplicate-and-looser zod bound.
  name: z.string(),
  workspaceDir: z
    .string()
    .min(1, "workspaceDir cannot be empty")
    // The absolute-path check stays in zod (rather than mirroring the
    // assertValid* pattern) for two reasons: there is no typed
    // `WorkspacePathInvalidError` to throw, and the downstream
    // `normalizeWorkspaceDir`'s `path.resolve` would silently
    // absolutize a relative input — so the rejection has to happen
    // here, before resolve masks the problem.
    .refine((p) => path.isAbsolute(p), "workspaceDir must be an absolute path"),
});

/**
 * Thrown by `WorkspaceService.register` when the input fails the zod
 * shape check (presence + types). Extends `Error` directly, NOT
 * `WorkspaceError` — an `instanceof WorkspaceError` filter will miss
 * it. The other writes (`open`, `rename`, `unregister`) bypass zod
 * and instead throw the typed `WorkspaceError` subclasses via the
 * `assertValid*` helpers.
 */
export class InputValidationError extends Error {
  constructor(scope: string, issues: readonly { path: readonly PropertyKey[]; message: string }[]) {
    super(
      `${scope} validation failed: ${issues
        .map((i) => `${i.path.map(String).join(".")}: ${i.message}`)
        .join("; ")}`,
    );
    this.name = "InputValidationError";
  }
}
