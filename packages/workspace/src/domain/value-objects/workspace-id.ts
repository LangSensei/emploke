import { isValidWorkspaceId } from "../../names.js";
import { WorkspaceIdInvalidError } from "../errors.js";

/**
 * Value object: opaque UUID identifying a workspace. URL routing key.
 *
 * Per naming-conventions §2 + §6 — private constructor + `static of`
 * factory that validates; structural `equals`; single `value` getter
 * exposing the underlying primitive.
 */
export class WorkspaceId {
  private constructor(public readonly value: string) {}

  /** Validate + wrap. Throws `WorkspaceIdInvalidError` on non-UUID input. */
  static of(value: string): WorkspaceId {
    if (!isValidWorkspaceId(value)) {
      throw new WorkspaceIdInvalidError(value);
    }
    return new WorkspaceId(value);
  }

  equals(other: WorkspaceId): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
