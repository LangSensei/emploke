import path from "node:path";

/**
 * Value object: absolute filesystem path the workspace lives under.
 * The directory itself is user-owned; emploke creates standard subdirs
 * (`sessions/`, `tasks/`) inside it.
 *
 * Input is always `path.resolve`d so equality is meaningful regardless
 * of whether the caller passed an absolute or relative path.
 */
export class WorkspaceDir {
  private constructor(public readonly value: string) {}

  /** Resolve to absolute + wrap. Throws when the input is empty / non-string. */
  static of(value: string): WorkspaceDir {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError(
        `WorkspaceDir.of: value must be a non-empty string, got ${String(value)}`,
      );
    }
    return new WorkspaceDir(path.resolve(value));
  }

  equals(other: WorkspaceDir): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
