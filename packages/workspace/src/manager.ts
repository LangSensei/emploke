import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { withFileLock, writeFileAtomic } from "./atomic.js";
import { CURRENT_SCHEMA_VERSION, WORKSPACE_FILE } from "./constants.js";
import {
  WorkspaceAlreadyExistsError,
  WorkspaceCorruptedError,
  WorkspaceNotFoundError,
  WorkspaceSchemaMismatchError,
} from "./errors.js";
import { assertValidWorkspaceName } from "./names.js";
import type { Workspace, WorkspaceMetadata } from "./types.js";
import { workspaceSubdirs } from "./types.js";

/** Options accepted by `WorkspaceManager.init` and `openOrInit`. */
export interface WorkspaceInitOpts {
  /**
   * Workspace name. If omitted, defaults to `path.basename(dir)`. Either way
   * the value must satisfy `assertValidWorkspaceName` (kebab-case, ≤ 64 chars).
   */
  readonly name?: string;
  /** Optional UX hints baked into `workspace.json`. */
  readonly defaults?: WorkspaceMetadata["defaults"];
  /** Test seam for `createdAt`. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/**
 * Lifecycle operations against a single workspace directory. All static —
 * the package never instantiates a `WorkspaceManager`; the type just
 * namespaces the verbs (`open`, `init`, `openOrInit`).
 *
 * Concurrency: `init` and `openOrInit` serialise writes through a per-dir
 * `<dir>/.workspace.lock` file, so two processes racing to create the same
 * workspace cannot end up with half-written `workspace.json` or duplicated
 * subdir creation errors.
 */
export class WorkspaceManager {
  private constructor() {
    // Static-only.
  }

  /**
   * Read `<dir>/workspace.json` and return a fully-resolved `Workspace`.
   *
   * Throws:
   *   - `WorkspaceNotFoundError` — file missing
   *   - `WorkspaceCorruptedError` — file unreadable / unparseable / wrong shape
   *   - `WorkspaceSchemaMismatchError` — schemaVersion mismatch
   */
  static async open(dir: string): Promise<Workspace> {
    const resolvedDir = path.resolve(dir);
    const metadataPath = path.join(resolvedDir, WORKSPACE_FILE);

    let raw: string;
    try {
      raw = await readFile(metadataPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new WorkspaceNotFoundError(resolvedDir);
      throw new WorkspaceCorruptedError(resolvedDir, `unreadable: ${(err as Error).message}`, {
        cause: err,
      });
    }

    const metadata = parseMetadata(resolvedDir, raw);
    return {
      dir: resolvedDir,
      metadata,
      ...workspaceSubdirs(resolvedDir),
    };
  }

  /**
   * Create `workspace.json` plus the standard subdirs (sessions/, tasks/,
   * workflows/, logs/). Throws `WorkspaceAlreadyExistsError` if
   * `workspace.json` already exists — use `openOrInit` if you want
   * idempotent semantics.
   */
  static async init(dir: string, opts: WorkspaceInitOpts = {}): Promise<Workspace> {
    const resolvedDir = path.resolve(dir);
    await mkdir(resolvedDir, { recursive: true });

    const lockPath = path.join(resolvedDir, ".workspace.lock");
    return withFileLock(lockPath, async () => {
      const metadataPath = path.join(resolvedDir, WORKSPACE_FILE);
      try {
        await stat(metadataPath);
        throw new WorkspaceAlreadyExistsError(resolvedDir);
      } catch (err) {
        if (
          err instanceof WorkspaceAlreadyExistsError ||
          (err as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          throw err;
        }
        // ENOENT — proceed.
      }

      const name = opts.name ?? path.basename(resolvedDir);
      assertValidWorkspaceName(name);
      const now = opts.now ?? (() => new Date());

      const metadata: WorkspaceMetadata = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        name,
        createdAt: now().toISOString(),
        ...(opts.defaults ? { defaults: opts.defaults } : {}),
      };

      const subdirs = workspaceSubdirs(resolvedDir);
      await Promise.all([
        mkdir(subdirs.sessionsDir, { recursive: true }),
        mkdir(subdirs.tasksDir, { recursive: true }),
        mkdir(subdirs.workflowsDir, { recursive: true }),
        mkdir(subdirs.logsDir, { recursive: true }),
      ]);

      await writeFileAtomic(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

      return {
        dir: resolvedDir,
        metadata,
        ...subdirs,
      };
    });
  }

  /**
   * Idempotent: if `workspace.json` exists, `open()`; otherwise `init(opts)`.
   * The race between the existence check and `init`'s subsequent stat is
   * resolved inside `init`'s lock — at most one caller succeeds; losers see
   * the file already exists and fall back to `open`.
   */
  static async openOrInit(dir: string, opts: WorkspaceInitOpts = {}): Promise<Workspace> {
    try {
      return await WorkspaceManager.open(dir);
    } catch (err) {
      if (!(err instanceof WorkspaceNotFoundError)) throw err;
    }
    try {
      return await WorkspaceManager.init(dir, opts);
    } catch (err) {
      if (err instanceof WorkspaceAlreadyExistsError) {
        return WorkspaceManager.open(dir);
      }
      throw err;
    }
  }
}

function parseMetadata(dir: string, raw: string): WorkspaceMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WorkspaceCorruptedError(dir, `json parse failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkspaceCorruptedError(dir, "expected an object");
  }
  const obj = parsed as Record<string, unknown>;

  const schemaVersion = obj.schemaVersion;
  if (typeof schemaVersion !== "number") {
    throw new WorkspaceCorruptedError(dir, "missing or non-numeric 'schemaVersion'");
  }
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new WorkspaceSchemaMismatchError(dir, schemaVersion, CURRENT_SCHEMA_VERSION);
  }

  if (typeof obj.name !== "string" || obj.name.length === 0) {
    throw new WorkspaceCorruptedError(dir, "missing or invalid 'name'");
  }
  if (typeof obj.createdAt !== "string" || obj.createdAt.length === 0) {
    throw new WorkspaceCorruptedError(dir, "missing or invalid 'createdAt'");
  }

  let defaults: WorkspaceMetadata["defaults"];
  if (obj.defaults !== undefined) {
    if (!obj.defaults || typeof obj.defaults !== "object" || Array.isArray(obj.defaults)) {
      throw new WorkspaceCorruptedError(dir, "'defaults' must be an object if present");
    }
    const d = obj.defaults as Record<string, unknown>;
    if (d.runtime !== undefined && typeof d.runtime !== "string") {
      throw new WorkspaceCorruptedError(dir, "'defaults.runtime' must be a string if present");
    }
    if (d.agent !== undefined && typeof d.agent !== "string") {
      throw new WorkspaceCorruptedError(dir, "'defaults.agent' must be a string if present");
    }
    defaults = {
      ...(typeof d.runtime === "string" ? { runtime: d.runtime } : {}),
      ...(typeof d.agent === "string" ? { agent: d.agent } : {}),
    };
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    name: obj.name,
    createdAt: obj.createdAt,
    ...(defaults ? { defaults } : {}),
  };
}
