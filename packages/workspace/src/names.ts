import { MAX_DISPLAY_NAME_LENGTH } from "./constants.js";
import { WorkspaceNameInvalidError } from "./domain/exceptions/workspace-errors.js";

/**
 * A workspace's `metadata.name` is a free-form display name. The only hard
 * constraints are:
 *  - non-empty after trim (whitespace-only names render as "" in the UI)
 *  - within `MAX_DISPLAY_NAME_LENGTH` chars (UTF-16 code units, not glyphs
 *    fine for a soft cap; the real persistence layer accepts anything)
 *  - no ASCII control characters (\u0000\u001F or \u007F)  these break
 *    log lines, file dialogs, and JSON readers
 *
 * Crucially this is NOT kebab-case validation. Workspace identity is now
 * a UUID; the display name carries zero structural meaning, so we let the
 * user pick whatever they want including Chinese, emoji, spaces.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control chars in user input is the point.
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

export function assertValidDisplayName(name: unknown): asserts name is string {
  if (typeof name !== "string") {
    throw new WorkspaceNameInvalidError(String(name), "must be a string");
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
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

/** True iff `name` would pass `assertValidDisplayName`. */
export function isValidDisplayName(name: unknown): name is string {
  try {
    assertValidDisplayName(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * RFC-4122 UUID format check. We accept any version (1, 3, 4, 5, 7)
 * because we only ever generate v4 ourselves, but external migrations or
 * future schemes shouldn't be artificially rejected.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidWorkspaceId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}
