import path from "node:path";
import {
  WorkspaceIdInvalidError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "../errors.js";
import { isValidWorkspaceId } from "../names.js";
import type { Workspace } from "../types.js";
import type { WorkspaceRepository } from "./repository.js";

/**
 * In-memory implementation of `WorkspaceRepository`. Useful for unit
 * tests that want to avoid the `mkdtemp` + `rm` cleanup ritual, and
 * for any future caller that wants ephemeral workspace state.
 *
 * Storage is plain `Map<id, Workspace>` plus a `currentId` slot. No
 * cross-process coordination (single-process by definition).
 *
 * Behaviour mirrors `FsWorkspaceRepository` for everything observable
 * by the manager: typed errors on invalid id / path conflict /
 * unregistered current selection.
 */
export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  private readonly entries = new Map<string, Workspace>();
  private currentId: string | null = null;

  /** Pre-seed the repository with workspaces. Useful for test fixtures. */
  constructor(seed: readonly Workspace[] = []) {
    for (const ws of seed) {
      this.entries.set(ws.id, freezeCopy(ws));
    }
  }

  async list(): Promise<Workspace[]> {
    return [...this.entries.values()];
  }

  async read(id: string): Promise<Workspace | null> {
    return this.entries.get(id) ?? null;
  }

  async save(workspace: Workspace): Promise<void> {
    if (!isValidWorkspaceId(workspace.id)) {
      throw new WorkspaceIdInvalidError(workspace.id);
    }
    const resolvedWorkdir = path.resolve(workspace.workdir);
    const conflict = [...this.entries.values()].find(
      (e) => e.workdir === resolvedWorkdir && e.id !== workspace.id,
    );
    if (conflict) {
      throw new WorkspacePathConflictError(resolvedWorkdir, conflict.id);
    }
    this.entries.set(workspace.id, freezeCopy({ ...workspace, workdir: resolvedWorkdir }));
  }

  async delete(id: string): Promise<void> {
    if (!this.entries.has(id)) return;
    this.entries.delete(id);
    if (this.currentId === id) this.currentId = null;
  }

  async getCurrent(): Promise<string | null> {
    return this.currentId;
  }

  async setCurrent(id: string): Promise<void> {
    if (!this.entries.has(id)) throw new WorkspaceNotRegisteredError(id);
    this.currentId = id;
  }
}

function freezeCopy(ws: Workspace): Workspace {
  return Object.freeze({ ...ws });
}
