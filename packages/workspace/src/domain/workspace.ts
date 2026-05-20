import { WorkspaceCorruptedError } from "./errors.js";
import type { WorkspaceDomainEvent } from "./events/domain-event.js";
import { WorkspaceRegistered } from "./events/workspace-registered.js";
import { WorkspaceRenamed } from "./events/workspace-renamed.js";
import { WorkspaceUnregistered } from "./events/workspace-unregistered.js";
import { WorkspaceDir } from "./value-objects/workspace-dir.js";
import { WorkspaceId } from "./value-objects/workspace-id.js";
import { WorkspaceName } from "./value-objects/workspace-name.js";

/**
 * Aggregate root: a single registered workspace.
 *
 * Identity = `id` (immutable UUID, the URL routing key).
 *
 * Mutation flows through methods that enforce invariants and raise
 * domain events into `_domainEvents`; the command handler drains the
 * buffer with {@link Workspace.pullDomainEvents} after `repo.save` and
 * dispatches each via the mediator (the eShop "Option A" pattern, see
 * naming-conventions §7).
 *
 * ## Construction (per naming-conventions §6)
 *
 * - {@link Workspace.register} — for fresh workspaces. Raises
 *   {@link WorkspaceRegistered}. Validation (id is UUID, name is
 *   non-empty + within length / charset rules) happens inside the
 *   value-object factories `WorkspaceId.of` / `WorkspaceName.of`.
 * - {@link Workspace.fromStored} — for rehydration from storage.
 *   Same shape checks, but surfaces {@link WorkspaceCorruptedError}
 *   carrying the on-disk `workspaceDir` for operator triage.
 *   Rehydration does NOT raise events — those belong to genuine
 *   state transitions, not to load-from-disk.
 *
 * ## Naming convention (locked alongside issue #121)
 *
 * `workspaceDir` (entity field) / `workspace_dir` (SQL column) is the
 * workspace's root directory. The shorter `workdir` is reserved for
 * derived per-entity working directories used by downstream packages
 * (`task.workdir = <workspaceDir>/tasks/<id>`,
 * `session.workdir = <workspaceDir>/sessions/<id>`).
 */
export class Workspace {
  private _domainEvents: WorkspaceDomainEvent[] = [];

  private constructor(
    private readonly _id: WorkspaceId,
    private _name: WorkspaceName,
    private readonly _workspaceDir: WorkspaceDir,
    private readonly _createdAt: string,
  ) {}

  /**
   * Build a fresh `Workspace` and raise {@link WorkspaceRegistered}.
   * Validation lives inside the value-object factories the caller
   * passes in; this method itself only assembles + records the event.
   */
  static register(args: {
    id: WorkspaceId;
    name: WorkspaceName;
    workspaceDir: WorkspaceDir;
    now: string;
  }): Workspace {
    const ws = new Workspace(args.id, args.name, args.workspaceDir, args.now);
    ws.addDomainEvent(
      new WorkspaceRegistered({
        id: args.id,
        name: args.name,
        workspaceDir: args.workspaceDir,
        registeredAt: args.now,
      }),
    );
    return ws;
  }

  /**
   * Reconstruct a `Workspace` from storage (e.g. a SQLite row).
   * Validation failures throw {@link WorkspaceCorruptedError} carrying
   * the on-disk `workspaceDir` for operator triage, rather than the
   * input-validation errors used by {@link Workspace.register}.
   *
   * Does NOT raise a `WorkspaceRegistered` event — rehydration is not
   * a domain transition.
   */
  static fromStored(args: {
    id: string;
    name: string;
    workspaceDir: string;
    createdAt: string;
  }): Workspace {
    if (typeof args.createdAt !== "string" || args.createdAt.length === 0) {
      throw new WorkspaceCorruptedError(args.workspaceDir, "missing or invalid 'createdAt'");
    }
    let id: WorkspaceId;
    let name: WorkspaceName;
    let workspaceDir: WorkspaceDir;
    try {
      id = WorkspaceId.of(args.id);
    } catch (err) {
      throw new WorkspaceCorruptedError(
        args.workspaceDir,
        `invalid 'id' (must be a UUID): ${args.id}`,
        { cause: err },
      );
    }
    try {
      name = WorkspaceName.of(args.name);
    } catch (err) {
      throw new WorkspaceCorruptedError(
        args.workspaceDir,
        `invalid 'name': ${(err as Error).message}`,
        { cause: err },
      );
    }
    try {
      workspaceDir = WorkspaceDir.of(args.workspaceDir);
    } catch (err) {
      throw new WorkspaceCorruptedError(
        args.workspaceDir,
        `invalid 'workspaceDir': ${(err as Error).message}`,
        { cause: err },
      );
    }
    return new Workspace(id, name, workspaceDir, args.createdAt);
  }

  // ── identity & metadata getters ─────────────────────────

  get id(): WorkspaceId {
    return this._id;
  }

  get name(): WorkspaceName {
    return this._name;
  }

  get workspaceDir(): WorkspaceDir {
    return this._workspaceDir;
  }

  get createdAt(): string {
    return this._createdAt;
  }

  // ── transitions ────────────────────────────────────────

  /**
   * Rename the workspace. No-op (and no event raised) when the new
   * name equals the current one — saves the event subscribers from
   * having to filter idempotent renames themselves.
   */
  rename(newName: WorkspaceName, now: string): void {
    if (this._name.equals(newName)) return;
    const oldName = this._name;
    this._name = newName;
    this.addDomainEvent(new WorkspaceRenamed({ id: this._id, oldName, newName, renamedAt: now }));
  }

  /**
   * Mark the workspace as unregistered (raises
   * {@link WorkspaceUnregistered}). The persistent row removal happens
   * in the command handler / repository — the aggregate just records
   * the transition for any future subscribers (Phase 1 has none).
   *
   * `purged` records the user's choice to also wipe emploke-owned
   * subdirs (`sessions/`, `tasks/`) on disk. Carried on the event so
   * downstream consumers (future audit log, cross-context cleanup
   * subscribers) see the same purge flag the handler acted on.
   */
  unregister(now: string, opts: { purged: boolean }): void {
    this.addDomainEvent(
      new WorkspaceUnregistered({
        id: this._id,
        purged: opts.purged,
        unregisteredAt: now,
      }),
    );
  }

  /**
   * Drain the buffered domain events. Command handlers call this AFTER
   * `repository.save(...)` so an event is only dispatched once the
   * write has succeeded. Resets the buffer on read — second drains
   * return `[]`.
   */
  pullDomainEvents(): readonly WorkspaceDomainEvent[] {
    const events = this._domainEvents;
    this._domainEvents = [];
    return events;
  }

  /**
   * Record an event raised by a transition. Protected (not exported)
   * — outside callers cannot inject events into the aggregate.
   */
  protected addDomainEvent(evt: WorkspaceDomainEvent): void {
    this._domainEvents.push(evt);
  }
}
