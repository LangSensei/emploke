import { Entity, PrimaryKey, Property } from "@mikro-orm/core";
import { WorkspaceCorruptedError } from "../../exceptions/workspace-errors.js";
import type { AggregateRoot } from "../../seedwork/aggregate-root.js";
import { Entity as DomainEntity } from "../../seedwork/entity.js";
import { WorkspaceDir } from "./workspace-dir.js";
import { WorkspaceId } from "./workspace-id.js";
import { WorkspaceName } from "./workspace-name.js";

/**
 * Aggregate root: a single registered workspace.
 *
 * ## Persistence shape
 *
 * The aggregate is decorated as a MikroORM `@Entity`. Fields are
 * **primitives** (not value objects) so the ORM can map them straight
 * to SQLite columns without a custom type. Validation lives in the
 * value-object factories used by the static constructors
 * (`WorkspaceId.of`, `WorkspaceName.of`, `WorkspaceDir.of`), which
 * throw typed errors the wire layer already knows how to map. Once a
 * row is inside the aggregate, the fields are trusted  public field
 * mutations are still gated by the named transition methods
 * (`rename`, `open`).
 *
 * ## Construction
 *
 *   - {@link Workspace.register}  for fresh workspaces.
 *   - {@link Workspace.fromStored}  for in-memory rehydration
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
 * No events are raised today: this aggregate has no cross-context
 * subscribers. The seedwork machinery (Entity events buffer +
 * `DomainEventDispatcher` MikroORM subscriber, with events typed as
 * mediatr-ts `NotificationData`) stays wired and latent. When a
 * transition needs a subscriber, add the event class AND its
 * notification handler in the same change, then call
 * `this.addDomainEvent(...)` from the transition. The dispatcher
 * does NOT swallow "no handler found" errors — a forgotten handler
 * fails the flush loudly, enforcing "no event class without a
 * handler" at runtime.
 *
 * ## Naming convention
 *
 * `workspaceDir` (entity field) / `workspace_dir` (SQL column) is the
 * workspace's root directory. The shorter `workdir` is reserved for
 * derived per-entity working directories used by downstream packages
 * (`task.workdir = <workspaceDir>/tasks/<id>`,
 * `session.workdir = <workspaceDir>/sessions/<id>`).
 */
@Entity({ tableName: "workspaces" })
export class Workspace extends DomainEntity implements AggregateRoot {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ name: "workspace_dir", unique: true })
  workspaceDir!: string;

  @Property()
  name!: string;

  @Property({ name: "created_at" })
  createdAt!: string;

  /**
   * ISO-8601 timestamp when the user last explicitly opened this
   * workspace. Set to `now` on registration (registration is implicit
   * "first open") and updated by {@link Workspace.open}. Drives
   * `WorkspaceQueries.getLastOpened`  the workspace with the highest
   * `lastOpenedAt` is the "current" one from the user's perspective.
   *
   * Nullable to allow future bulk-imported / fixture rows that haven't
   * been opened yet  but in normal flow (register  open  ...) it
   * is always set.
   */
  @Property({ name: "last_opened_at", nullable: true, type: "string" })
  lastOpenedAt: string | null = null;

  /**
   * MikroORM-friendly constructor. Protected to discourage `new
   * Workspace()` from outside the aggregate  use {@link register} or
   * {@link fromStored} instead. MikroORM's hydration path bypasses
   * the constructor entirely (it uses `Object.create`-style entity
   * instantiation), so the protected modifier is purely a guardrail
   * for human callers.
   */
  protected constructor() {
    super();
  }

  /**
   * Build a fresh `Workspace`. Validation lives inside the
   * value-object factories the caller passes in; this method itself
   * only assembles fields.
   *
   * The returned entity is detached from any EntityManager. The
   * command handler calls `em.persist(ws)` to enroll it in the
   * unit-of-work; the subsequent `em.flush` (driven by
   * `TransactionBehavior`) writes the INSERT.
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
    ws.lastOpenedAt = args.now;
    return ws;
  }

  /**
   * Reconstruct a `Workspace` from raw primitive fields (e.g. test
   * fixtures or migration backfills). Production reads go through
   * MikroORM's `em.findOne` / `em.find` hydration path, which skips
   * this factory and skips constructor invocation entirely  but the
   * factory remains useful for test code that wants a tracked-but-
   * detached aggregate without standing up an EntityManager.
   *
   * Validation failures throw {@link WorkspaceCorruptedError} carrying
   * the on-disk `workspaceDir` for operator triage, rather than the
   * input-validation errors used by {@link Workspace.register}.
   */
  static fromStored(args: {
    id: string;
    name: string;
    workspaceDir: string;
    createdAt: string;
    lastOpenedAt?: string | null;
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
    ws.lastOpenedAt = args.lastOpenedAt ?? null;
    return ws;
  }

  //  transitions ─

  /**
   * Rename the workspace. No-op when the new name equals the current
   * one  keeps the unit-of-work change-set empty and saves a
   * pointless UPDATE.
   */
  rename(newName: WorkspaceName): void {
    if (this.name === newName.value) return;
    this.name = newName.value;
  }

  /**
   * Mark the workspace as just-opened by updating `lastOpenedAt`. The
   * workspace with the highest `lastOpenedAt` is what
   * `WorkspaceQueries.getLastOpened` returns  opening makes this
   * workspace the registry's "current" one.
   */
  open(now: string): void {
    this.lastOpenedAt = now;
  }
}
