import { assertValidDisplayName } from "../../names.js";

/**
 * Value object: workspace display name. Free-form unicode, 1-64
 * trimmed chars, no ASCII control chars (see `assertValidDisplayName`
 * for the full rules).
 */
export class WorkspaceName {
  private constructor(public readonly value: string) {}

  /** Validate + wrap. Throws `WorkspaceNameInvalidError` on bad input. */
  static of(value: string): WorkspaceName {
    assertValidDisplayName(value);
    return new WorkspaceName(value);
  }

  equals(other: WorkspaceName): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
