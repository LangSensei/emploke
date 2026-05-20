import { rm } from "node:fs/promises";
import { inject, injectable } from "inversify";
import type { RequestHandler } from "mediatr-ts";
import { Clock } from "../../domain/clock.js";
import { WorkspaceId } from "../../domain/value-objects/workspace-id.js";
import { WorkspaceRepository } from "../../domain/workspace-repository.js";
import { workspaceLayout } from "../../workspace-layout.js";
import type { UnregisterWorkspaceCommand } from "./unregister-workspace.command.js";

/**
 * Handle {@link UnregisterWorkspaceCommand}: optionally purge
 * emploke-owned subdirs on disk, then drop the registry row.
 * `WorkspaceUnregistered` is published by `DomainEventSubscriber`
 * after the surrounding `em.flush` writes the DELETE.
 *
 * For `purge=true` we read the workspace BEFORE deleting, purge subdirs,
 * THEN drop the registry entry. Removing the entry first opens a race
 * window where a concurrent register with the same `workspaceDir` could
 * succeed (no path conflict in the index anymore) and start populating
 * `sessions/` / `tasks/` — which the in-flight purge would then nuke.
 * Doing the purge first keeps the path-conflict guard active throughout.
 *
 * Idempotent for unregistered ids — `repo.delete()` short-circuits
 * when the row is missing and the aggregate's `unregister` event is
 * never raised.
 */
@injectable()
export class UnregisterWorkspaceCommandHandler
  implements RequestHandler<UnregisterWorkspaceCommand, void>
{
  constructor(
    @inject(WorkspaceRepository) private readonly repo: WorkspaceRepository,
    @inject(Clock) private readonly clock: Clock,
  ) {}

  async handle(cmd: UnregisterWorkspaceCommand): Promise<void> {
    const id = WorkspaceId.of(cmd.id);

    const existing = await this.repo.findById(id);
    if (!existing) {
      // Idempotent: delete on a missing row is a no-op, no event.
      // We still call repo.delete to keep the contract symmetric for
      // any future "soft delete" implementations.
      await this.repo.delete(id);
      return;
    }

    if (cmd.purge) {
      const layout = workspaceLayout(existing.workspaceDir);
      await Promise.all([
        rm(layout.sessions, { recursive: true, force: true }),
        rm(layout.tasks, { recursive: true, force: true }),
      ]);
    }

    existing.unregister(this.clock.nowIso(), { purged: cmd.purge });
    await this.repo.delete(id);
    // `em.remove(existing)` happened inside repo.delete(); the
    // surrounding TransactionBehavior's flush writes the DELETE
    // AND fires DomainEventSubscriber.afterFlush which publishes
    // the WorkspaceUnregistered event we just raised on the
    // aggregate.
  }
}
