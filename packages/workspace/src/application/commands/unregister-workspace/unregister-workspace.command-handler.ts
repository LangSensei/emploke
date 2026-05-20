import { rm } from "node:fs/promises";
import { inject, injectable } from "inversify";
import { Mediator, type RequestHandler } from "mediatr-ts";
import { Clock } from "../../../domain/clock.js";
import { publishWorkspaceEvent } from "../../../domain/publish-event.js";
import { WorkspaceId } from "../../../domain/value-objects/workspace-id.js";
import { WorkspaceRepository } from "../../../domain/workspace-repository.js";
import { workspaceLayout } from "../../../workspace-layout.js";
import type { UnregisterWorkspaceCommand } from "./unregister-workspace.command.js";

/**
 * Handle {@link UnregisterWorkspaceCommand}: optionally purge
 * emploke-owned subdirs on disk, then drop the registry row, then
 * publish the `WorkspaceUnregistered` event.
 *
 * For `purge=true` we read the workspace BEFORE deleting, purge subdirs,
 * THEN drop the registry entry. Removing the entry first opens a race
 * window where a concurrent register with the same `workspaceDir` could
 * succeed (no path conflict in the index anymore) and start populating
 * `sessions/` / `tasks/` — which the in-flight purge would then nuke.
 * Doing the purge first keeps the path-conflict guard active throughout.
 *
 * Idempotent for unregistered ids — the repo's `delete()` short-circuits
 * when the row is missing, and no event is published in that case.
 */
@injectable()
export class UnregisterWorkspaceCommandHandler
  implements RequestHandler<UnregisterWorkspaceCommand, void>
{
  constructor(
    @inject(WorkspaceRepository) private readonly repo: WorkspaceRepository,
    @inject(Mediator) private readonly mediator: Mediator,
    @inject(Clock) private readonly clock: Clock,
  ) {}

  async handle(cmd: UnregisterWorkspaceCommand): Promise<void> {
    const id = WorkspaceId.of(cmd.id);

    const existing = await this.repo.findById(id);
    if (!existing) {
      // Idempotent: delete on a missing row is a no-op, no event.
      await this.repo.delete(id);
      return;
    }

    if (cmd.purge) {
      const layout = workspaceLayout(existing.workspaceDir.value);
      await Promise.all([
        rm(layout.sessions, { recursive: true, force: true }),
        rm(layout.tasks, { recursive: true, force: true }),
      ]);
    }

    await this.repo.delete(id);

    existing.unregister(this.clock.nowIso(), { purged: cmd.purge });
    for (const evt of existing.pullDomainEvents()) {
      await publishWorkspaceEvent(this.mediator, evt);
    }
  }
}
