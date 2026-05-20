import { WorkspaceIdInvalidError } from "../../../exceptions/workspace-errors.js";

/**
 * RFC-4122 UUID format. We accept any version (1, 3, 4, 5, 7) — we
 * generate v4 ourselves but external migrations or future schemes
 * shouldn't be artificially rejected.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Value object: opaque UUID identifying a workspace. URL routing key.
 *
 * Per naming-conventions §2 + §6 — private constructor + `static of`
 * factory that validates; structural `equals`; single `value` getter
 * exposing the underlying primitive. Validation rule lives here as
 * the single source of truth.
 */
export class WorkspaceId {
  private constructor(public readonly value: string) {}

  /** Validate + wrap. Throws `WorkspaceIdInvalidError` on non-UUID input. */
  static of(value: string): WorkspaceId {
    WorkspaceId.assertValid(value);
    return new WorkspaceId(value);
  }

  /** Throws `WorkspaceIdInvalidError` if `id` is not a valid UUID. */
  static assertValid(id: unknown): asserts id is string {
    if (!WorkspaceId.isValid(id)) {
      throw new WorkspaceIdInvalidError(typeof id === "string" ? id : String(id));
    }
  }

  /** True iff `id` is a string matching the UUID format. */
  static isValid(id: unknown): id is string {
    return typeof id === "string" && UUID_RE.test(id);
  }

  equals(other: WorkspaceId): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
