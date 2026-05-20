import { WorkspaceNameInvalidError } from "../../exceptions/workspace-errors.js";
import { ValueObject } from "../../seedwork/value-object.js";

/** Maximum allowed length of the display name (UTF-16 code units). */
const MAX_DISPLAY_NAME_LENGTH = 64;

/**
 * A workspace's display name is free-form. Hard constraints:
 *  - non-empty after trim (whitespace-only renders as "" in UIs)
 *  - within `MAX_DISPLAY_NAME_LENGTH` chars (UTF-16 code units)
 *  - no ASCII control characters (\u0000-\u001F or \u007F) — these
 *    break log lines, file dialogs, and JSON readers
 *
 * Crucially this is NOT kebab-case validation. Workspace identity is
 * a UUID; the display name carries zero structural meaning, so we
 * accept Chinese, emoji, spaces — anything safe to render.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control chars in user input is the point.
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/**
 * Value object: workspace display name. Validation rules live here as
 * the single source of truth — Zod input validators only do shape /
 * anti-DoS bounds, then delegate to `WorkspaceName.assertValid` for
 * the business rule.
 */
export class WorkspaceName extends ValueObject {
  private constructor(public readonly value: string) {
    super();
  }

  /** Validate + wrap. Throws `WorkspaceNameInvalidError` on bad input. */
  static of(value: string): WorkspaceName {
    WorkspaceName.assertValid(value);
    return new WorkspaceName(value);
  }

  /**
   * Throws `WorkspaceNameInvalidError` if `name` is not a valid
   * display name. Single source of truth for the rule — the Zod
   * input validators delegate here rather than re-encoding it.
   */
  static assertValid(name: unknown): asserts name is string {
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

  /** True iff `name` would pass `WorkspaceName.assertValid`. */
  static isValid(name: unknown): name is string {
    try {
      WorkspaceName.assertValid(name);
      return true;
    } catch {
      return false;
    }
  }

  protected override equalityComponents(): readonly unknown[] {
    return [this.value];
  }

  override toString(): string {
    return this.value;
  }
}
