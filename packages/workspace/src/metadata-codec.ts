import path from "node:path";
import { CURRENT_SCHEMA_VERSION } from "./constants.js";
import { WorkspaceCorruptedError, WorkspaceSchemaMismatchError } from "./errors.js";
import { isValidDisplayName } from "./names.js";
import type { Workspace } from "./types.js";

/**
 * Parsed shape of the per-workspace metadata file (`workspace.json`)
 * the FS repository writes. Carried separately from the public
 * `Workspace` value type because the on-disk shape includes the
 * schema-version envelope; the domain type does not.
 */
export interface PersistedWorkspaceMetadata {
  readonly schemaVersion: number;
  readonly name: string;
  readonly createdAt: string;
  readonly defaults?: {
    readonly runtime?: string;
    readonly agent?: string;
  };
}

/**
 * Build the wire-format payload for a workspace's metadata file.
 * Inverse of {@link parseWorkspaceMetadata}.
 *
 * Both implementations of `WorkspaceRepository` (filesystem-backed
 * and SQLite-backed) share this so the metadata file's on-disk shape
 * stays in lock-step regardless of where the index lives.
 */
export function serializeWorkspaceMetadata(workspace: Workspace): PersistedWorkspaceMetadata {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    name: workspace.name,
    createdAt: workspace.createdAt,
    ...(workspace.defaults ? { defaults: workspace.defaults } : {}),
  };
}

/**
 * Parse a raw value (typically the result of `readJson`) into a
 * `Workspace`. Throws `WorkspaceCorruptedError` for shape failures and
 * `WorkspaceSchemaMismatchError` when the on-disk schemaVersion does
 * not match this build.
 *
 * `id` and `workdir` are supplied by the caller (they live in the
 * index, not in the per-workspace file); the function only validates
 * and decodes the metadata fields.
 */
export function parseWorkspaceMetadata(id: string, workdir: string, raw: unknown): Workspace {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkspaceCorruptedError(workdir, "expected an object");
  }
  const obj = raw as Record<string, unknown>;
  const schemaVersion = obj.schemaVersion;
  if (typeof schemaVersion !== "number") {
    throw new WorkspaceCorruptedError(workdir, "missing or non-numeric 'schemaVersion'");
  }
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new WorkspaceSchemaMismatchError(workdir, schemaVersion, CURRENT_SCHEMA_VERSION);
  }
  if (typeof obj.name !== "string") {
    throw new WorkspaceCorruptedError(workdir, "missing or non-string 'name'");
  }
  if (!isValidDisplayName(obj.name)) {
    throw new WorkspaceCorruptedError(
      workdir,
      "'name' is not a valid display name (empty/whitespace/too long/contains control chars)",
    );
  }
  if (typeof obj.createdAt !== "string" || obj.createdAt.length === 0) {
    throw new WorkspaceCorruptedError(workdir, "missing or invalid 'createdAt'");
  }

  let defaults: Workspace["defaults"];
  if (obj.defaults !== undefined) {
    if (!obj.defaults || typeof obj.defaults !== "object" || Array.isArray(obj.defaults)) {
      throw new WorkspaceCorruptedError(workdir, "'defaults' must be an object if present");
    }
    const d = obj.defaults as Record<string, unknown>;
    if (d.runtime !== undefined && typeof d.runtime !== "string") {
      throw new WorkspaceCorruptedError(workdir, "'defaults.runtime' must be a string if present");
    }
    if (d.agent !== undefined && typeof d.agent !== "string") {
      throw new WorkspaceCorruptedError(workdir, "'defaults.agent' must be a string if present");
    }
    defaults = {
      ...(typeof d.runtime === "string" ? { runtime: d.runtime } : {}),
      ...(typeof d.agent === "string" ? { agent: d.agent } : {}),
    };
  }

  return {
    id,
    workdir: path.resolve(workdir),
    name: obj.name,
    createdAt: obj.createdAt,
    ...(defaults ? { defaults } : {}),
  };
}
