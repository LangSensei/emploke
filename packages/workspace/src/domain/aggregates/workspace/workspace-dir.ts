import path from "node:path";
import { ValueObject } from "../../seedwork/value-object.js";

/**
 * Value object: absolute filesystem path the workspace lives under.
 * The directory itself is user-owned; emploke creates standard subdirs
 * (`sessions/`, `tasks/`) inside it.
 *
 * Input is always `path.resolve`d so equality is meaningful regardless
 * of whether the caller passed an absolute or relative path.
 */
export class WorkspaceDir extends ValueObject {
  private constructor(public readonly value: string) {
    super();
  }

  /** Resolve to absolute + wrap. Throws when the input is empty / non-string. */
  static of(value: string): WorkspaceDir {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError(
        `WorkspaceDir.of: value must be a non-empty string, got ${String(value)}`,
      );
    }
    return new WorkspaceDir(path.resolve(value));
  }

  protected override equalityComponents(): readonly unknown[] {
    return [this.value];
  }

  override toString(): string {
    return this.value;
  }
}
