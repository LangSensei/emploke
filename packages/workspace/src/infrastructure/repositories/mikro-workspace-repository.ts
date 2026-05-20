import { inject, injectable } from "inversify";
import { Workspace } from "../../domain/aggregates/workspace/workspace.js";
import type { WorkspaceId } from "../../domain/aggregates/workspace/workspace-id.js";
import { WorkspaceRepository } from "../../domain/aggregates/workspace/workspace-repository.js";
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
}
