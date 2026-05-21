import type { EntityManager } from "@mikro-orm/core";
import { Workspace } from "./entity.js";

/**
 * Persistence surface for `Workspace`.
 *
 * Plain class — no DI container, no abstract / repository pattern
 * ceremony beyond what the service finds convenient. Tests inject a
 * fork of the test EM directly; production wires the same way via
 * `composeWorkspaceModule`.
 *
 * Methods do NOT call `em.flush`. The service wraps each use case in
 * `em.transactional(() => ...)` and lets MikroORM flush on close.
 */
export class WorkspaceRepository {
  constructor(private readonly em: EntityManager) {}

  /** Enroll a fresh row with the unit-of-work. */
  add(ws: Workspace): void {
    this.em.persist(ws);
  }

  findById(id: string): Promise<Workspace | null> {
    return this.em.findOne(Workspace, { id });
  }

  findByPath(workspaceDir: string): Promise<Workspace | null> {
    return this.em.findOne(Workspace, { workspaceDir });
  }

  async delete(id: string): Promise<void> {
    const ws = await this.em.findOne(Workspace, { id });
    if (!ws) return;
    this.em.remove(ws);
  }
}
