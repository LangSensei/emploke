import { Entity, PrimaryKey, Property } from "@mikro-orm/core";
import { WorkspaceCorruptedError } from "../../exceptions/workspace-errors.js";
import { AggregateRoot } from "../../seedwork/aggregate-root.js";
import { WorkspaceRegistered } from "./events/workspace-registered.js";
import { WorkspaceRenamed } from "./events/workspace-renamed.js";
import { WorkspaceUnregistered } from "./events/workspace-unregistered.js";
import { WorkspaceDir } from "./value-objects/workspace-dir.js";
import { WorkspaceId } from "./value-objects/workspace-id.js";
import { WorkspaceName } from "./value-objects/workspace-name.js";

/**
 * Aggregate root: a single registered workspace.
 *
 * ## Persistence shape (Phase 2 / ADR-3)
 *
 * The aggregate is decorated as a MikroORM `@Entity`. Fields are
 * **primitives** (not value objects) so the ORM can map them straight
 * to SQLite columns without a custom type. Validation lives in the
 * value-object factories used by the static constructors
 * (`WorkspaceId.of`, `WorkspaceName.of`, `WorkspaceDir.of`), which
 * throw typed errors the wire layer already knows how to map. Once a
 * row is inside the aggregate, the fields are trusted — public field
 * mutations are still gated by the named transition methods
 * (`rename`, `unregister`).
 *
 * ## Construction
 *
 *   - {@link Workspace.register} — for fresh workspaces. Raises
 *     {@link WorkspaceRegistered} into the AggregateRoot event buffer.
 *   - {@link Workspace.fromStored} — for in-memory rehydration
 *     (tests, fixtures). MikroORM has its own hydration path that
 *     skips constructors entirely; `fromStored` is the equivalent for
 *     non-ORM callers and surfaces {@link WorkspaceCorruptedError}
 *     when the input fails validation.
 *
 * The constructor itself is `protected`. MikroORM v7 instantiates
 * entities via the runtime `Reflect`/property-init path, so a
 * `private` constructor would break hydration; `protected` keeps
 * direct `new Workspace()` calls out of caller code while staying
 * inside what the ORM accepts.
 *
 * ## Domain events
 *
 * Buffered on the base class (see `AggregateRoot`). The Phase-2
 * `DomainEventSubscriber` walks the unit-of-work change-set after
 * each flush and dispatches each event via `mediator.publish` — no
 * more per-handler publish loop.
 *
 * ## Naming convention (locked alongside issue #121)
 *
 * `workspaceDir` (entity field) / `workspace_dir` (SQL column) is the
 * workspace's root directory. The shorter `workdir` is reserved for
 * derived per-entity working directories used by downstream packages
 * (`task.workdir = <workspaceDir>/tasks/<id>`,
 * `session.workdir = <workspaceDir>/sessions/<id>`).
 */
@Entity({ tableName: "workspaces" })
export class Workspace extends AggregateRoot {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ name: "workspace_dir", unique: true })
  workspaceDir!: string;

  @Property()
  name!: string;

  @Property({ name: "created_at" })
  createdAt!: string;

  /**
   * MikroORM-friendly constructor. Protected to discourage `new
   * Workspace()` from outside the aggregate — use {@link register} or
   * {@link fromStored} instead. MikroORM's hydration path bypasses
   * the constructor entirely (it uses `Object.create`-style entity
   * instantiation), so the protected modifier is purely a guardrail
   * for human callers.
   */
  protected constructor() {
    super();
  }

  /**
   * Build a fresh `Workspace` and raise {@link WorkspaceRegistered}.
   * Validation lives inside the value-object factories the caller
   * passes in; this method itself only assembles + records the event.
   *
   * The returned entity is detached from any EntityManager. The
   * command handler calls `em.persist(ws)` to enroll it in the
   * unit-of-work; the subsequent `em.flush` (driven by
   * `TransactionBehavior`) writes the INSERT and fires the
   * `afterFlush` subscriber.
   */
  static register(args: {
    id: WorkspaceId;
    name: WorkspaceName;
    workspaceDir: WorkspaceDir;
    now: string;
  }): Workspace {
    const ws = new Workspace();
    ws.id = args.id.value;
    ws.name = args.name.value;
    ws.workspaceDir = args.workspaceDir.value;
    ws.createdAt = args.now;
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
   * Reconstruct a `Workspace` from raw primitive fields (e.g. test
   * fixtures or migration backfills). Production reads go through
   * MikroORM's `em.findOne` / `em.find` hydration path, which skips
   * this factory and skips constructor invocation entirely — but the
   * factory remains useful for test code that wants a tracked-but-
   * detached aggregate without standing up an EntityManager.
   *
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
    try {
      WorkspaceId.of(args.id);
    } catch (err) {
      throw new WorkspaceCorruptedError(
        args.workspaceDir,
        `invalid 'id' (must be a UUID): ${args.id}`,
        { cause: err },
      );
    }
    try {
      WorkspaceName.of(args.name);
    } catch (err) {
      throw new WorkspaceCorruptedError(
        args.workspaceDir,
        `invalid 'name': ${(err as Error).message}`,
        { cause: err },
      );
    }
    try {
      WorkspaceDir.of(args.workspaceDir);
    } catch (err) {
      throw new WorkspaceCorruptedError(
        args.workspaceDir,
        `invalid 'workspaceDir': ${(err as Error).message}`,
        { cause: err },
      );
    }
    const ws = new Workspace();
    ws.id = args.id;
    ws.name = args.name;
    ws.workspaceDir = args.workspaceDir;
    ws.createdAt = args.createdAt;
    return ws;
  }

  // ── transitions ────────────────────────────────────────

  /**
   * Rename the workspace. No-op (and no event raised) when the new
   * name equals the current one — saves the event subscribers from
   * having to filter idempotent renames themselves.
   */
  rename(newName: WorkspaceName, now: string): void {
    if (this.name === newName.value) return;
    const oldNameVO = WorkspaceName.of(this.name);
    this.name = newName.value;
    this.addDomainEvent(
      new WorkspaceRenamed({
        id: WorkspaceId.of(this.id),
        oldName: oldNameVO,
        newName,
        renamedAt: now,
      }),
    );
  }

  /**
   * Mark the workspace as unregistered (raises
   * {@link WorkspaceUnregistered}). The persistent row removal
   * happens in the repository's `delete()` (which calls `em.remove`);
   * the aggregate just records the transition for downstream
   * subscribers.
   *
   * `purged` records the user's choice to also wipe emploke-owned
   * subdirs (`sessions/`, `tasks/`) on disk. Carried on the event so
   * downstream consumers (future audit log, cross-context cleanup
   * subscribers) see the same purge flag the handler acted on.
   */
  unregister(now: string, opts: { purged: boolean }): void {
    this.addDomainEvent(
      new WorkspaceUnregistered({
        id: WorkspaceId.of(this.id),
        purged: opts.purged,
        unregisteredAt: now,
      }),
    );
  }
}
