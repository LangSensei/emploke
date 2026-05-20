import { inject, injectable } from "inversify";
import type { NotificationHandler } from "mediatr-ts";
import type { WorkspaceUnregistered } from "../../domain/aggregates/workspace/events/workspace-unregistered.js";
import { WorkspaceContext } from "../../infrastructure/workspace-context.js";

/**
 * Cascade-clean the global_state.current_workspace_id pointer when
 * the workspace it pointed to gets unregistered. Subscribes to the
 * WorkspaceUnregistered domain event via mediatr-ts notification
 * dispatch (fired by DomainEventDispatcher in MikroORM beforeFlush,
 * so this handler runs inside the same em.transactional scope as the
 * DELETE on the workspaces table - atomic from the caller POV).
 *
 * Replaces the previous tight coupling inside MikroWorkspaceRepository.delete
 * which called em.execute("DELETE FROM global_state ...") itself.
 * Repository now stays single-aggregate; cross-row cleanup is a
 * domain-event concern.
 *
 * Idempotent: deleting a non-matching row is a no-op (AND value = ?
 * with the unregistered id ensures only the relevant pointer clears).
 */
@injectable()
export class ClearCurrentOnUnregisterHandler implements NotificationHandler<WorkspaceUnregistered> {
  constructor(@inject(WorkspaceContext) private readonly ctx: WorkspaceContext) {}

  async handle(notification: WorkspaceUnregistered): Promise<void> {
    await this.ctx.sqlEm.execute("DELETE FROM global_state WHERE key = ? AND value = ?", [
      "current_workspace_id",
      notification.id.value,
    ]);
  }
}
