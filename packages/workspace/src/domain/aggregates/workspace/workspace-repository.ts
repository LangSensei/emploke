import type { Workspace } from "./workspace.js";
import type { WorkspaceId } from "./workspace-id.js";

/**
 * Storage contract for the workspace aggregate.
 *
 * Mirrors eShop's `IOrderRepository`: methods return the aggregate
 * (not id/void) wherever the caller benefits from a tracked entity in
 * hand. The repository depends on MikroORM's unit-of-work via
 * WorkspaceContext: callers do NOT call save/flush; TransactionBehavior's
 * em.transactional orchestrates the flush at pipeline tail and
 * DomainEventDispatcher (beforeFlush hook) fires accumulated domain
 * events.
 *
 * Declared as an abstract class (not TS interface) so the same name
 * doubles as the inversify DI token. Implementations live under
 * infrastructure/repositories/.
 */
export abstract class WorkspaceRepository {
  /**
   * Enroll a newly-constructed Workspace aggregate with the
   * unit-of-work and return it (eShop OrderRepository.Add style).
   * The aggregate is tracked from this point - subsequent mutations
   * roll into the upcoming flush.
   *
   * Input is validated by ValidationBehavior before this method is
   * called; uniqueness collisions surface from the SQL UNIQUE
   * constraint at flush time and get translated to typed domain
   * errors by the implementation.
   */
  abstract add(ws: Workspace): Promise<Workspace>;

  /**
   * Look up a single workspace by id. Returns null when no workspace
   * with that id is registered (404-on-the-wire); throws for storage
   * faults the caller should care about. The returned aggregate is
   * tracked.
   */
  abstract findById(id: WorkspaceId): Promise<Workspace | null>;

  /**
   * Look up by absolute filesystem path. Returns null when no
   * workspace occupies the path.
   */
  abstract findByPath(workspaceDir: string): Promise<Workspace | null>;

  /**
   * Remove the workspace from the registry. Idempotent (delete on a
   * missing id is a no-op). Does NOT touch agent-owned content under
   * the workspace's workspaceDir - that concern lives in the
   * UnregisterWorkspaceCommandHandler.
   */
  abstract delete(id: WorkspaceId): Promise<void>;
}
