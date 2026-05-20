import { inject, injectable } from "inversify";
import type { WorkspaceId } from "../../domain/aggregates/workspace/value-objects/workspace-id.js";
import { Workspace } from "../../domain/aggregates/workspace/workspace.js";
import { WorkspaceRepository } from "../../domain/aggregates/workspace/workspace-repository.js";
import { WorkspaceNotRegisteredError } from "../../domain/exceptions/workspace-errors.js";
import { GLOBAL_STATE_KEYS, GlobalState } from "../../domain/global-state.js";
import { WorkspaceContext } from "../workspace-context.js";

/**
 * MikroORM-backed WorkspaceRepository.
 *
 * Repository depends on the unit-of-work via WorkspaceContext - methods
 * persist/remove via em, never call flush themselves. TransactionBehavior
 * (em.transactional at pipeline tail) drives the flush; UNIQUE
 * collisions get pre-checked by ValidationBehavior so they rarely
 * surface from SQL. If a TOCTOU race ever fires one, it bubbles up as
 * a 500 - acceptable for single-user emploke (the validator pre-check
 * eliminates 99.999% of conflicts).
 *
 * Cross-row cleanup on aggregate delete (e.g. clearing
 * global_state.current_workspace_id when the pointed-to workspace
 * goes away) is a domain-event concern, handled by
 * ClearCurrentOnUnregisterDomainEventHandler. Repository.delete stays pure
 * single-aggregate.
 *
 * The current-workspace pointer (`getCurrent` / `setCurrent`) is read
 * + written through the {@link GlobalState} entity rather than raw
 * SQL — same UoW + transaction envelope as the aggregate.
 */
@injectable()
export class MikroWorkspaceRepository extends WorkspaceRepository {
  constructor(@inject(WorkspaceContext) private readonly ctx: WorkspaceContext) {
    super();
  }

  override async add(ws: Workspace): Promise<Workspace> {
    this.ctx.em.persist(ws);
    return ws;
  }

  override async findById(id: WorkspaceId): Promise<Workspace | null> {
    return this.ctx.em.findOne(Workspace, { id: id.value });
  }

  override async findByPath(workspaceDir: string): Promise<Workspace | null> {
    return this.ctx.em.findOne(Workspace, { workspaceDir });
  }

  override async delete(id: WorkspaceId): Promise<void> {
    const ws = await this.ctx.em.findOne(Workspace, { id: id.value });
    if (!ws) return;
    this.ctx.em.remove(ws);
  }

  override async getCurrent(): Promise<Workspace | null> {
    const pointer = await this.ctx.em.findOne(GlobalState, {
      key: GLOBAL_STATE_KEYS.CURRENT_WORKSPACE_ID,
    });
    if (!pointer) return null;
    return this.ctx.em.findOne(Workspace, { id: pointer.value });
  }

  override async setCurrent(id: WorkspaceId): Promise<void> {
    const exists = await this.ctx.em.findOne(Workspace, { id: id.value });
    if (!exists) {
      throw new WorkspaceNotRegisteredError(id.value);
    }
    // upsert against the GlobalState entity. MikroORM's `em.upsert`
    // emits the driver-specific INSERT ... ON CONFLICT under the hood
    // (better-sqlite uses SQLite's `ON CONFLICT(key) DO UPDATE`), so
    // a second setCurrent call overwrites the previous pointer
    // without raising a UNIQUE violation.
    await this.ctx.em.upsert(
      GlobalState,
      GlobalState.of(GLOBAL_STATE_KEYS.CURRENT_WORKSPACE_ID, id.value),
    );
  }
}
