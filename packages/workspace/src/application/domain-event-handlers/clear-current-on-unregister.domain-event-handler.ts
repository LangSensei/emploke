import { inject, injectable } from "inversify";
import type { NotificationHandler } from "mediatr-ts";
import type { WorkspaceUnregistered } from "../../domain/aggregates/workspace/events/workspace-unregistered.js";
import { GLOBAL_STATE_KEYS, GlobalState } from "../../domain/global-state.js";
import { WorkspaceContext } from "../../infrastructure/workspace-context.js";

/**
 * Cascade-clean the global_state.current_workspace_id pointer when
 * the workspace it pointed to gets unregistered. Subscribes to the
 * WorkspaceUnregistered domain event via mediatr-ts notification
 * dispatch (fired by DomainEventDispatcher in MikroORM beforeFlush,
 * so this handler runs inside the same em.transactional scope as the
 * DELETE on the workspaces table - atomic commit/rollback together).
 *
 * Replaces the previous tight coupling inside MikroWorkspaceRepository.delete
 * which called em.execute("DELETE FROM global_state ...") itself.
 * Repository now stays single-aggregate; cross-row cleanup is a
 * domain-event concern.
 *
 * Conditional: only clears the pointer when it actually points at the
 * unregistered workspace. Unregistering a non-current workspace must
 * leave the pointer untouched. Implemented via findOne + em.remove so
 * the cleanup flows through the UoW change-set, consistent with how
 * the Workspace aggregate itself is removed elsewhere.
 */
@injectable()
export class ClearCurrentOnUnregisterDomainEventHandler
  implements NotificationHandler<WorkspaceUnregistered>
{
  constructor(@inject(WorkspaceContext) private readonly ctx: WorkspaceContext) {}

  async handle(notification: WorkspaceUnregistered): Promise<void> {
    const pointer = await this.ctx.em.findOne(GlobalState, {
      key: GLOBAL_STATE_KEYS.CURRENT_WORKSPACE_ID,
    });
    if (pointer && pointer.value === notification.id.value) {
      this.ctx.em.remove(pointer);
    }
  }
}
