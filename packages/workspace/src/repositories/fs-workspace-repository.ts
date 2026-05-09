import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { mkdirP, readJson, withFileLock, writeJsonAtomic } from "@emploke/storage";
import { CURRENT_SCHEMA_VERSION, WORKSPACE_FILE } from "../constants.js";
import {
  RegistryCorruptedError,
  RegistrySchemaMismatchError,
  WorkspaceCorruptedError,
  WorkspaceIdInvalidError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
  WorkspaceSchemaMismatchError,
} from "../errors.js";
import { isValidDisplayName, isValidWorkspaceId } from "../names.js";
import type { Workspace } from "../types.js";
import type { WorkspaceRepository } from "./repository.js";

/**
 * Filesystem implementation of `WorkspaceRepository`.
 *
 * Storage layout (the wire format; never leaks into the public API):
 *
 *   <root>/workspaces.json                  ← index of registered workspaces
 *   <ws.workdir>/workspace.json             ← per-workspace metadata
 *
 * **Index** is a single JSON document keyed by id, listing every
 * registered workspace's `id` and `workdir`, plus an optional
 * `currentId`. We hold an advisory lock around every read-modify-write
 * (`<root>/workspaces.json.lock`) so two server instances pointed at
 * the same root cannot lose each other's index updates.
 *
 * **Per-workspace metadata** is the mutable part — `name`, `createdAt`,
 * `defaults` — written atomically with the same primitives every other
 * Fs Repository uses (tmpfile + rename + EPERM retry).
 *
 * Migration: pre-UUID legacy registries (with `name`-keyed entries
 * instead of UUIDs) are auto-upgraded on first read; the upgraded
 * index is rewritten before the call returns so subsequent processes
 * see a stable file.
 */
export class FsWorkspaceRepository implements WorkspaceRepository {
  private readonly indexFile: string;
  private readonly lockFile: string;

  constructor(opts: { indexFile: string }) {
    this.indexFile = path.resolve(opts.indexFile);
    this.lockFile = `${this.indexFile}.lock`;
  }

  async list(): Promise<Workspace[]> {
    const index = await this.readIndex();
    // For each entry, hydrate metadata from the per-workspace file.
    // Entries whose metadata file is missing or corrupted are dropped
    // here so a single bad workspace does not take down the whole list.
    // Single-id callers (`read(id)`) still get the typed error; only the
    // list path swallows it.
    const out: Workspace[] = [];
    for (const entry of index.entries) {
      let ws: Workspace | null = null;
      try {
        ws = await this.tryHydrate(entry);
      } catch {
        // Corrupted / unreadable workspace.json — drop silently. The
        // entry stays in the index until the user explicitly removes
        // (or re-registers) the workspace.
      }
      if (ws) out.push(ws);
    }
    return out;
  }

  async read(id: string): Promise<Workspace | null> {
    const index = await this.readIndex();
    const entry = index.entries.find((e) => e.id === id);
    if (!entry) return null;
    return this.tryHydrate(entry);
  }

  async save(workspace: Workspace): Promise<void> {
    if (!isValidWorkspaceId(workspace.id)) {
      throw new WorkspaceIdInvalidError(workspace.id);
    }
    const resolvedWorkdir = path.resolve(workspace.workdir);
    // Persist the per-workspace metadata first. If this fails we never
    // touch the index — better to have an unregistered workspace than
    // a phantom index entry pointing at no metadata.
    const metadataFile = path.join(resolvedWorkdir, WORKSPACE_FILE);
    const persistedMetadata = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      name: workspace.name,
      createdAt: workspace.createdAt,
      ...(workspace.defaults ? { defaults: workspace.defaults } : {}),
    };
    await writeJsonAtomic(metadataFile, persistedMetadata);

    // Then add / refresh the index entry under the lock.
    await this.mutateIndex((current) => {
      const next: IndexEntry = { id: workspace.id, workdir: resolvedWorkdir };
      const byPath = current.entries.find(
        (e) => e.workdir === resolvedWorkdir && e.id !== workspace.id,
      );
      if (byPath) throw new WorkspacePathConflictError(resolvedWorkdir, byPath.id);

      const replaced = current.entries.map((e) =>
        e.id === workspace.id
          ? e.lastOpenedAt !== undefined
            ? { ...next, lastOpenedAt: e.lastOpenedAt }
            : next
          : e,
      );
      const inserted = replaced.some((e) => e.id === workspace.id) ? replaced : [...replaced, next];
      return current.currentId !== undefined
        ? { entries: inserted, currentId: current.currentId }
        : { entries: inserted };
    });
  }

  async delete(id: string): Promise<void> {
    let removedWorkdir: string | null = null;
    await this.mutateIndex((current) => {
      const entry = current.entries.find((e) => e.id === id);
      if (!entry) {
        // Idempotent: deleting a missing id leaves the index untouched
        // and we'll return without removing any metadata file.
        return current;
      }
      removedWorkdir = entry.workdir;
      const entries = current.entries.filter((e) => e.id !== id);
      const next: IndexState =
        current.currentId === id
          ? { entries }
          : current.currentId !== undefined
            ? { entries, currentId: current.currentId }
            : { entries };
      return next;
    });
    if (removedWorkdir) {
      // Remove the per-workspace metadata file. Fs cleanup of agent-owned
      // sub-paths (tasks/, sessions/, ...) is the manager's purge concern,
      // not the repository's.
      const metadataFile = path.join(removedWorkdir, WORKSPACE_FILE);
      await rm(metadataFile, { force: true });
    }
  }

  async getCurrent(): Promise<string | null> {
    const index = await this.readIndex();
    return index.currentId ?? null;
  }

  async setCurrent(id: string): Promise<void> {
    const stamp = new Date().toISOString();
    await this.mutateIndex((current) => {
      const entry = current.entries.find((e) => e.id === id);
      if (!entry) throw new WorkspaceNotRegisteredError(id);
      const entries = current.entries.map((e) => (e.id === id ? { ...e, lastOpenedAt: stamp } : e));
      return { entries, currentId: id };
    });
  }

  // ── internals ───────────────────────────────────────────────

  private async tryHydrate(entry: IndexEntry): Promise<Workspace | null> {
    const metadataFile = path.join(entry.workdir, WORKSPACE_FILE);
    let raw: unknown;
    try {
      raw = await readJson(metadataFile);
    } catch (err) {
      throw new WorkspaceCorruptedError(
        entry.workdir,
        `unreadable workspace.json: ${(err as Error).message}`,
        { cause: err },
      );
    }
    if (raw === null) {
      // Metadata file was removed out from under us. Drop from the
      // hydrated list rather than throwing — the index will heal next
      // time someone calls `delete(id)` or re-registers.
      return null;
    }
    return parseWorkspace(entry.id, entry.workdir, raw);
  }

  private async readIndex(): Promise<IndexState> {
    let raw: unknown;
    try {
      raw = await readJson(this.indexFile);
    } catch (err) {
      throw new RegistryCorruptedError(
        this.indexFile,
        `json parse failed: ${(err as Error).message}`,
        { cause: err },
      );
    }
    if (raw === null) {
      return { entries: [] };
    }
    const parsed = parseIndex(this.indexFile, raw);
    if (parsed.migrated) {
      await writeJsonAtomic(this.indexFile, serializeIndex(parsed.state));
    }
    return parsed.state;
  }

  private async mutateIndex(fn: (current: IndexState) => IndexState): Promise<void> {
    // Ensure the parent dir for the lockfile + index exists. Fresh
    // server starts on a system that has never run emploke hit this.
    await mkdirP(path.dirname(this.indexFile));
    await withFileLock(this.lockFile, async () => {
      // Re-read inside the lock so we observe other processes' edits.
      let current: IndexState;
      try {
        const raw = await readJson(this.indexFile);
        if (raw === null) {
          current = { entries: [] };
        } else {
          current = parseIndex(this.indexFile, raw).state;
        }
      } catch (err) {
        throw new RegistryCorruptedError(
          this.indexFile,
          `json parse failed: ${(err as Error).message}`,
          { cause: err },
        );
      }
      const next = fn(current);
      await writeJsonAtomic(this.indexFile, serializeIndex(next));
    });
  }
}

// ── wire-format helpers (private to this file) ──────────────────

interface IndexEntry {
  readonly id: string;
  readonly workdir: string;
  readonly lastOpenedAt?: string;
}

interface IndexState {
  readonly entries: readonly IndexEntry[];
  readonly currentId?: string;
}

interface PersistedIndex {
  readonly schemaVersion: number;
  readonly entries: readonly IndexEntry[];
  readonly currentId?: string;
}

function serializeIndex(state: IndexState): PersistedIndex {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    entries: state.entries,
    ...(state.currentId !== undefined ? { currentId: state.currentId } : {}),
  };
}

interface ParsedIndex {
  readonly state: IndexState;
  readonly migrated: boolean;
}

function parseIndex(file: string, raw: unknown): ParsedIndex {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RegistryCorruptedError(file, "expected an object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    if (typeof obj.schemaVersion === "number" && Number.isFinite(obj.schemaVersion)) {
      throw new RegistrySchemaMismatchError(file, obj.schemaVersion, CURRENT_SCHEMA_VERSION);
    }
    throw new RegistryCorruptedError(
      file,
      `unsupported schemaVersion: ${JSON.stringify(obj.schemaVersion)}`,
    );
  }
  if (!Array.isArray(obj.entries)) {
    throw new RegistryCorruptedError(file, "'entries' must be an array");
  }

  const entries: IndexEntry[] = [];
  // Map old `name` → new id so we can migrate `currentName` → `currentId`
  // without re-reading the file or re-parsing.
  const oldNameToId = new Map<string, string>();
  let migrated = false;

  for (const [i, e] of obj.entries.entries()) {
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      throw new RegistryCorruptedError(file, `entries[${i}] must be an object`);
    }
    const en = e as Record<string, unknown>;
    // Accept both new `workdir` and legacy `path` keys (the field used to
    // be called `path`; rename happened during the storage refactor).
    const rawWorkdir = typeof en.workdir === "string" ? en.workdir : en.path;
    if (typeof rawWorkdir !== "string" || rawWorkdir.length === 0) {
      throw new RegistryCorruptedError(file, `entries[${i}].workdir missing or invalid`);
    }
    if (en.workdir === undefined) migrated = true;
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
      workdir: path.resolve(rawWorkdir),
      ...(typeof en.lastOpenedAt === "string" ? { lastOpenedAt: en.lastOpenedAt } : {}),
    });
  }

  let currentId: string | undefined;
  if (obj.currentId !== undefined) {
    if (typeof obj.currentId !== "string" || obj.currentId.length === 0) {
      throw new RegistryCorruptedError(file, "'currentId' must be a non-empty string if present");
    }
    if (!isValidWorkspaceId(obj.currentId)) {
      throw new RegistryCorruptedError(file, "'currentId' is not a valid uuid");
    }
    currentId = obj.currentId;
  } else if (obj.currentName !== undefined) {
    if (typeof obj.currentName !== "string" || obj.currentName.length === 0) {
      throw new RegistryCorruptedError(file, "'currentName' must be a non-empty string if present");
    }
    const mapped = oldNameToId.get(obj.currentName);
    if (mapped) currentId = mapped;
    migrated = true;
  }

  if (currentId && !entries.some((e) => e.id === currentId)) {
    currentId = undefined;
  }

  return { state: currentId !== undefined ? { entries, currentId } : { entries }, migrated };
}

function parseWorkspace(id: string, workdir: string, raw: unknown): Workspace {
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
