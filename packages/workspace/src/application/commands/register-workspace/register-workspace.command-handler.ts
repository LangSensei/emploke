import { mkdir } from "node:fs/promises";
import { inject, injectable } from "inversify";
import { Mediator, type RequestHandler } from "mediatr-ts";
import { Clock } from "../../../domain/clock.js";
import { publishWorkspaceEvent } from "../../../domain/publish-event.js";
import { WorkspaceDir } from "../../../domain/value-objects/workspace-dir.js";
import { WorkspaceId } from "../../../domain/value-objects/workspace-id.js";
import { WorkspaceName } from "../../../domain/value-objects/workspace-name.js";
import { Workspace } from "../../../domain/workspace.js";
import { WorkspaceRepository } from "../../../domain/workspace-repository.js";
import { workspaceLayout } from "../../../workspace-layout.js";
import type { RegisterWorkspaceCommand } from "./register-workspace.command.js";

/**
 * Handle {@link RegisterWorkspaceCommand}: create the workspace
 * directory + standard subdirs on disk, then persist the workspace
 * metadata via the repository, then publish any raised domain events.
 *
 * The id-uniqueness + path-uniqueness checks are delegated to
 * `WorkspaceRepository.create`, which performs them inside the
 * registry's critical section. A previous implementation did the
 * checks at the manager layer (`findById` + `save`), which had a race
 * window where two concurrent `register({id: same})` calls could both
 * pass the check and then silently overwrite each other in `save`.
 * `create` closes that window.
 */
@injectable()
export class RegisterWorkspaceCommandHandler
  implements RequestHandler<RegisterWorkspaceCommand, { id: string }>
{
  constructor(
    @inject(WorkspaceRepository) private readonly repo: WorkspaceRepository,
    @inject(Mediator) private readonly mediator: Mediator,
    @inject(Clock) private readonly clock: Clock,
  ) {}

  async handle(cmd: RegisterWorkspaceCommand): Promise<{ id: string }> {
    const id = WorkspaceId.of(cmd.id);
    const name = WorkspaceName.of(cmd.name);
    const workspaceDir = WorkspaceDir.of(cmd.workspaceDir);

    // Create the workspace directory + standard subdirs. The user's
    // pre-existing files inside `workspaceDir` are preserved; we only
    // touch the named subdirs. We do this BEFORE calling
    // `repository.create` so the layout is in place by the time the
    // metadata row is written; if `create` throws (id or path conflict),
    // the empty subdirs we just created stick around but are harmless.
    await mkdir(workspaceDir.value, { recursive: true });
    const layout = workspaceLayout(workspaceDir.value);
    await Promise.all([
      mkdir(layout.sessions, { recursive: true }),
      mkdir(layout.tasks, { recursive: true }),
    ]);

    const ws = Workspace.register({
      id,
      name,
      workspaceDir,
      now: this.clock.nowIso(),
    });
    await this.repo.create(ws);

    // Publish AFTER successful save (Option A in
    // naming-conventions §7). A future Phase 1+ pipeline behavior
    // can wrap the save + publish in a single unit-of-work tx, but
    // for Phase 1 there are zero subscribers so `publishWorkspaceEvent`
    // tolerates the "no subscribers" error from mediatr-ts.
    for (const evt of ws.pullDomainEvents()) {
      await publishWorkspaceEvent(this.mediator, evt);
    }

    return { id: ws.id.value };
  }
}
