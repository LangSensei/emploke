import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock, writeFileAtomic } from "./atomic.js";
import { CURRENT_SCHEMA_VERSION } from "./constants.js";
import {
  RegistryCorruptedError,
  WorkspaceIdConflictError,
  WorkspaceIdInvalidError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "./errors.js";
import { isValidWorkspaceId } from "./names.js";
import type { RegistryEntry, RegistryFile } from "./types.js";

/** Options accepted by `WorkspaceRegistry.add`. */
export interface RegistryAddOpts {
  /**
   * Workspace UUID. Almost always omitted  the registry generates a v4
   * UUID. Tests / migrations may pin a specific id.
   */
  readonly id?: string;
  /** Absolute path to the workspace directory. */
  readonly path: string;
}

/**
 * Home-level registry of known workspaces, persisted at
 * `$EMPLOKE_HOME/workspaces.json`. Maps UUID ids to absolute paths and
 * remembers which workspace was last selected.
 *
 * The registry does NOT manage workspace files  adding doesn't create
 * `workspace.json`, removing doesn't delete subdirectories. Callers compose
 * `WorkspaceManager.openOrInit` with `WorkspaceRegistry.add` to do both.
 *
 * Concurrency: every mutation (`add`, `remove`, `setCurrent`) takes the
 * `<file>.lock` advisory lock around its read-modify-write, so concurrent
 * processes can't lose each other's updates.
 *
 * Forward-migration: pre-UUID registry entries (those keyed by a kebab-case
 * `name` field) are auto-upgraded on first read. A v4 UUID is assigned and
 * the migrated registry is written back atomically before `open()` returns,
 * so subsequent processes see a stable file.
 */
export class WorkspaceRegistry {
  private constructor(
    private readonly file: string,
    private state: RegistryFile,
  ) {}

  /**
   * Open the registry at `file`. A missing file is treated as an empty
   * registry (the common first-run case). A malformed file throws
   * `RegistryCorruptedError`  we refuse to silently overwrite user data.
   *
   * If the on-disk file is in the legacy `name`-keyed shape, it is
   * migrated to the UUID-keyed shape and rewritten before this method
   * returns.
   */
  static async open(file: string): Promise<WorkspaceRegistry> {
    const resolvedFile = path.resolve(file);
    await mkdir(path.dirname(resolvedFile), { recursive: true });

    let state: RegistryFile;
    let migrated = false;
    try {
      const raw = await readFile(resolvedFile, "utf8");
      const parsed = parseRegistry(resolvedFile, raw);
      state = parsed.state;
      migrated = parsed.migrated;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        state = { schemaVersion: CURRENT_SCHEMA_VERSION, entries: [] };
      } else {
        throw err;
      }
    }

    if (migrated) {
      await writeFileAtomic(resolvedFile, `${JSON.stringify(state, null, 2)}\n`);
    }
    return new WorkspaceRegistry(resolvedFile, state);
  }

  /**
   * Snapshot of all registered workspaces.
   *
   * IMPORTANT: this is the in-memory view captured at `open()` (or after the
   * last successful `add` / `remove` / `setCurrent` *on this instance*).
   * Mutations made by another process between `open()` and this call are
   * NOT reflected. Cross-process consumers that need fresh data should
   * either re-`open()` the registry, or perform a no-op `setCurrent` /
   * `add` to force the instance through `mutate()` (which always re-reads).
   *
   * This is intentional: the read APIs are sync and dependency-free, which
   * keeps the dashboard's "list workspaces" path snappy. Multi-process
   * deployments are not the primary use-case today.
   */
  list(): readonly RegistryEntry[] {
    return this.state.entries;
  }

  /** True iff a workspace with `id` is registered. */
  has(id: string): boolean {
    return this.state.entries.some((e) => e.id === id);
  }

  /** Lookup by id; undefined if missing. */
  get(id: string): RegistryEntry | undefined {
    return this.state.entries.find((e) => e.id === id);
  }

  /** Id of the last-selected workspace, or null. */
  current(): string | null {
    return this.state.currentId ?? null;
  }

  /**
   * Add a workspace to the registry. Generates a v4 UUID id when `opts.id`
   * is omitted. Throws `WorkspaceIdConflictError` if the id is already
   * taken (test/migration scenario), or `WorkspacePathConflictError` if
   * the path is already registered under a different id.
   *
   * The check + write happen atomically under the file lock so two
   * concurrent `add()`s cannot both succeed for the same id.
   *
   * Returns the resolved entry so callers don't have to re-read it.
   */
  async add(opts: RegistryAddOpts): Promise<RegistryEntry> {
    const id = opts.id ?? randomUUID();
    if (!isValidWorkspaceId(id)) {
      throw new WorkspaceIdInvalidError(id);
    }
    const absPath = path.resolve(opts.path);
    let added: RegistryEntry | undefined;
    await this.mutate((state) => {
      const byId = state.entries.find((e) => e.id === id);
      if (byId) throw new WorkspaceIdConflictError(id);
      const byPath = state.entries.find((e) => e.path === absPath);
      if (byPath) throw new WorkspacePathConflictError(absPath, byPath.id);
      const entry: RegistryEntry = { id, path: absPath };
      added = entry;
      return { ...state, entries: [...state.entries, entry] };
    });
    // mutate() always either ran update or threw; `added` is set on the
    // happy path. Non-null assertion is local + obvious.
    if (!added) throw new Error("registry add: internal invariant violated");
    return added;
  }

  /**
   * Remove a workspace from the registry. Does not touch the workspace's
   * files. If the removed entry was `currentId`, clears it. Throws
   * `WorkspaceNotRegisteredError` if no such id exists.
   */
  async remove(id: string): Promise<void> {
    await this.mutate((state) => {
      if (!state.entries.some((e) => e.id === id)) {
        throw new WorkspaceNotRegisteredError(id);
      }
      const entries = state.entries.filter((e) => e.id !== id);
      const currentId = state.currentId === id ? undefined : state.currentId;
      return currentId === undefined
        ? { schemaVersion: state.schemaVersion, entries }
        : { schemaVersion: state.schemaVersion, entries, currentId };
    });
  }

  /**
   * Mark `id` as the current workspace and bump its `lastOpenedAt`.
   * Throws `WorkspaceNotRegisteredError` if no such id exists.
   */
  async setCurrent(id: string, now: () => Date = () => new Date()): Promise<void> {
    await this.mutate((state) => {
      if (!state.entries.some((e) => e.id === id)) {
        throw new WorkspaceNotRegisteredError(id);
      }
      const stamp = now().toISOString();
      const entries = state.entries.map((e) => (e.id === id ? { ...e, lastOpenedAt: stamp } : e));
      return { schemaVersion: state.schemaVersion, entries, currentId: id };
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
        onDisk = parseRegistry(this.file, raw).state;
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

interface ParseResult {
  readonly state: RegistryFile;
  /** True if the on-disk file used the legacy `name`-keyed shape. */
  readonly migrated: boolean;
}

function parseRegistry(file: string, raw: string): ParseResult {
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
  // Map old `name`  new id so we can migrate `currentName`  `currentId`
  // without re-reading the file or re-parsing.
  const oldNameToId = new Map<string, string>();
  let migrated = false;
  for (const [i, e] of obj.entries.entries()) {
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      throw new RegistryCorruptedError(file, `entries[${i}] must be an object`);
    }
    const en = e as Record<string, unknown>;
    if (typeof en.path !== "string" || en.path.length === 0) {
      throw new RegistryCorruptedError(file, `entries[${i}].path missing or invalid`);
    }
    if (en.lastOpenedAt !== undefined && typeof en.lastOpenedAt !== "string") {
      throw new RegistryCorruptedError(file, `entries[${i}].lastOpenedAt must be a string`);
    }

    let id: string;
    if (typeof en.id === "string" && en.id.length > 0) {
      if (!isValidWorkspaceId(en.id)) {
        throw new RegistryCorruptedError(file, `entries[${i}].id is not a valid uuid`);
      }
      id = en.id;
    } else if (typeof en.name === "string" && en.name.length > 0) {
      id = randomUUID();
      oldNameToId.set(en.name, id);
      migrated = true;
    } else {
      throw new RegistryCorruptedError(file, `entries[${i}] missing both 'id' and legacy 'name'`);
    }

    entries.push({
      id,
      path: en.path,
      ...(typeof en.lastOpenedAt === "string" ? { lastOpenedAt: en.lastOpenedAt } : {}),
    });
  }

  let currentId: string | undefined;
  if (obj.currentId !== undefined) {
    // Strict: a present-but-malformed currentId is corruption, not "ignore".
    if (typeof obj.currentId !== "string" || obj.currentId.length === 0) {
      throw new RegistryCorruptedError(file, "'currentId' must be a non-empty string if present");
    }
    if (!isValidWorkspaceId(obj.currentId)) {
      throw new RegistryCorruptedError(file, "'currentId' is not a valid uuid");
    }
    currentId = obj.currentId;
  } else if (obj.currentName !== undefined) {
    // Strict (matches currentId above): a malformed currentName is also
    // corruption rather than silently dropped. Only a well-formed
    // currentName that maps to a known migrated entry yields a currentId.
    if (typeof obj.currentName !== "string" || obj.currentName.length === 0) {
      throw new RegistryCorruptedError(file, "'currentName' must be a non-empty string if present");
    }
    const mapped = oldNameToId.get(obj.currentName);
    if (mapped) {
      currentId = mapped;
      migrated = true;
    }
    // currentName referencing an unknown name: drop and force-migrate so we
    // overwrite the legacy field instead of leaving it on disk forever.
    migrated = true;
  }

  // Drop currentId if it points at an entry we didn't keep (defensive).
  if (currentId && !entries.some((e) => e.id === currentId)) {
    currentId = undefined;
  }

  const state: RegistryFile =
    currentId === undefined
      ? { schemaVersion: CURRENT_SCHEMA_VERSION, entries }
      : { schemaVersion: CURRENT_SCHEMA_VERSION, entries, currentId };
  return { state, migrated };
}
