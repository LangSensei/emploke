import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock, writeFileAtomic } from "./atomic.js";
import { CURRENT_SCHEMA_VERSION } from "./constants.js";
import {
  RegistryCorruptedError,
  WorkspaceNameConflictError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "./errors.js";
import { assertValidWorkspaceName } from "./names.js";
import type { RegistryEntry, RegistryFile } from "./types.js";

/** Options accepted by `WorkspaceRegistry.add`. */
export interface RegistryAddOpts {
  /** Workspace name (the URL identifier). Required, kebab-case. */
  readonly name: string;
  /** Absolute path to the workspace directory. */
  readonly path: string;
}

/**
 * Home-level registry of known workspaces, persisted at
 * `$EMPLOKE_HOME/workspaces.json`. Maps URL-routing names to absolute paths
 * and remembers which workspace was last selected.
 *
 * The registry does NOT manage workspace files — adding doesn't create
 * `workspace.json`, removing doesn't delete subdirectories. Callers compose
 * `WorkspaceManager.openOrInit` with `WorkspaceRegistry.add` to do both.
 *
 * Concurrency: every mutation (`add`, `remove`, `setCurrent`) takes the
 * `<file>.lock` advisory lock around its read-modify-write, so concurrent
 * processes can't lose each other's updates.
 */
export class WorkspaceRegistry {
  private constructor(
    private readonly file: string,
    private state: RegistryFile,
  ) {}

  /**
   * Open the registry at `file`. A missing file is treated as an empty
   * registry (the common first-run case). A malformed file throws
   * `RegistryCorruptedError` — we refuse to silently overwrite user data.
   */
  static async open(file: string): Promise<WorkspaceRegistry> {
    const resolvedFile = path.resolve(file);
    await mkdir(path.dirname(resolvedFile), { recursive: true });

    let state: RegistryFile;
    try {
      const raw = await readFile(resolvedFile, "utf8");
      state = parseRegistry(resolvedFile, raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        state = { schemaVersion: CURRENT_SCHEMA_VERSION, entries: [] };
      } else {
        throw err;
      }
    }
    return new WorkspaceRegistry(resolvedFile, state);
  }

  /** Snapshot of all registered workspaces. */
  list(): readonly RegistryEntry[] {
    return this.state.entries;
  }

  /** True iff a workspace named `name` is registered. */
  has(name: string): boolean {
    return this.state.entries.some((e) => e.name === name);
  }

  /** Lookup by name; undefined if missing. */
  get(name: string): RegistryEntry | undefined {
    return this.state.entries.find((e) => e.name === name);
  }

  /** Name of the last-selected workspace, or null. */
  current(): string | null {
    return this.state.currentName ?? null;
  }

  /**
   * Add a workspace to the registry. Validates `name` (kebab-case, length).
   * Throws `WorkspaceNameConflictError` if the name is taken, or
   * `WorkspacePathConflictError` if the path is already registered under
   * a different name.
   *
   * The check + write happen atomically under the file lock so two
   * concurrent `add()`s with the same name can't both succeed.
   */
  async add(opts: RegistryAddOpts): Promise<void> {
    assertValidWorkspaceName(opts.name);
    const absPath = path.resolve(opts.path);
    await this.mutate((state) => {
      const byName = state.entries.find((e) => e.name === opts.name);
      if (byName) throw new WorkspaceNameConflictError(opts.name);
      const byPath = state.entries.find((e) => e.path === absPath);
      if (byPath) throw new WorkspacePathConflictError(absPath, byPath.name);
      const entry: RegistryEntry = { name: opts.name, path: absPath };
      return { ...state, entries: [...state.entries, entry] };
    });
  }

  /**
   * Remove a workspace from the registry. Does not touch the workspace's
   * files. If the removed entry was `currentName`, clears it. Throws
   * `WorkspaceNotRegisteredError` if no such name exists.
   */
  async remove(name: string): Promise<void> {
    await this.mutate((state) => {
      if (!state.entries.some((e) => e.name === name)) {
        throw new WorkspaceNotRegisteredError(name);
      }
      const entries = state.entries.filter((e) => e.name !== name);
      const currentName = state.currentName === name ? undefined : state.currentName;
      return currentName === undefined
        ? { schemaVersion: state.schemaVersion, entries }
        : { schemaVersion: state.schemaVersion, entries, currentName };
    });
  }

  /**
   * Mark `name` as the current workspace and bump its `lastOpenedAt`.
   * Throws `WorkspaceNotRegisteredError` if no such name exists.
   */
  async setCurrent(name: string, now: () => Date = () => new Date()): Promise<void> {
    await this.mutate((state) => {
      if (!state.entries.some((e) => e.name === name)) {
        throw new WorkspaceNotRegisteredError(name);
      }
      const stamp = now().toISOString();
      const entries = state.entries.map((e) =>
        e.name === name ? { ...e, lastOpenedAt: stamp } : e,
      );
      return { schemaVersion: state.schemaVersion, entries, currentName: name };
    });
  }

  /**
   * Read-modify-write under the lock. Re-reads the file inside the lock so
   * we observe any changes made by other processes between `open()` and
   * this call. After a successful write we update our in-memory snapshot.
   */
  private async mutate(update: (state: RegistryFile) => RegistryFile): Promise<void> {
    const lockPath = `${this.file}.lock`;
    await withFileLock(lockPath, async () => {
      let onDisk: RegistryFile;
      try {
        const raw = await readFile(this.file, "utf8");
        onDisk = parseRegistry(this.file, raw);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          onDisk = { schemaVersion: CURRENT_SCHEMA_VERSION, entries: [] };
        } else {
          throw err;
        }
      }
      const next = update(onDisk);
      await writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
      this.state = next;
    });
  }
}

function parseRegistry(file: string, raw: string): RegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RegistryCorruptedError(file, `json parse failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RegistryCorruptedError(file, "expected an object");
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new RegistryCorruptedError(
      file,
      `unsupported schemaVersion: ${JSON.stringify(obj.schemaVersion)}`,
    );
  }

  if (!Array.isArray(obj.entries)) {
    throw new RegistryCorruptedError(file, "'entries' must be an array");
  }
  const entries: RegistryEntry[] = [];
  for (const [i, e] of obj.entries.entries()) {
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      throw new RegistryCorruptedError(file, `entries[${i}] must be an object`);
    }
    const en = e as Record<string, unknown>;
    if (typeof en.name !== "string" || en.name.length === 0) {
      throw new RegistryCorruptedError(file, `entries[${i}].name missing or invalid`);
    }
    if (typeof en.path !== "string" || en.path.length === 0) {
      throw new RegistryCorruptedError(file, `entries[${i}].path missing or invalid`);
    }
    if (en.lastOpenedAt !== undefined && typeof en.lastOpenedAt !== "string") {
      throw new RegistryCorruptedError(file, `entries[${i}].lastOpenedAt must be a string`);
    }
    entries.push({
      name: en.name,
      path: en.path,
      ...(typeof en.lastOpenedAt === "string" ? { lastOpenedAt: en.lastOpenedAt } : {}),
    });
  }

  let currentName: string | undefined;
  if (obj.currentName !== undefined) {
    if (typeof obj.currentName !== "string" || obj.currentName.length === 0) {
      throw new RegistryCorruptedError(file, "'currentName' must be a non-empty string if present");
    }
    currentName = obj.currentName;
  }

  return currentName === undefined
    ? { schemaVersion: CURRENT_SCHEMA_VERSION, entries }
    : { schemaVersion: CURRENT_SCHEMA_VERSION, entries, currentName };
}
