import { inject, injectable } from "inversify";
import { Mediator, type RequestHandler } from "mediatr-ts";
import { Clock } from "../../../domain/clock.js";
import { WorkspaceNotRegisteredError } from "../../../domain/errors.js";
import { publishWorkspaceEvent } from "../../../domain/publish-event.js";
import { WorkspaceId } from "../../../domain/value-objects/workspace-id.js";
import { WorkspaceName } from "../../../domain/value-objects/workspace-name.js";
import { WorkspaceRepository } from "../../../domain/workspace-repository.js";
import type { RenameWorkspaceCommand } from "./rename-workspace.command.js";

/**
 * Handle {@link RenameWorkspaceCommand}: rename the workspace, persist,
 * publish the `WorkspaceRenamed` event.
 *
 * Throws `WorkspaceNotRegisteredError` when no workspace with the
 * given id exists — including the rare race where a concurrent
 * unregister lands between this handler's `findById()` and `save()`
 * calls (the strict-update semantics in
 * {@link WorkspaceRepository.save} surface that as a typed 404 instead
 * of silently resurrecting the deleted row).
 */
@injectable()
export class RenameWorkspaceCommandHandler implements RequestHandler<RenameWorkspaceCommand, void> {
  constructor(
    @inject(WorkspaceRepository) private readonly repo: WorkspaceRepository,
    @inject(Mediator) private readonly mediator: Mediator,
    @inject(Clock) private readonly clock: Clock,
  ) {}

  async handle(cmd: RenameWorkspaceCommand): Promise<void> {
    const id = WorkspaceId.of(cmd.id);
    const newName = WorkspaceName.of(cmd.newName);

    const ws = await this.repo.findById(id);
    if (!ws) throw new WorkspaceNotRegisteredError(id.value);

    ws.rename(newName, this.clock.nowIso());

    // Skip the write-lock + UPDATE round-trip for no-op renames
    // (when newName equals the current name, the aggregate's `rename`
    // short-circuits and raises no event). Reviewer note on PR #138:
    // unconditional save acquires BEGIN IMMEDIATE for byte-identical
    // rows, wasted work under contention on a real global.db.
    const events = ws.pullDomainEvents();
    if (events.length === 0) return;

    await this.repo.save(ws);

    for (const evt of events) {
      await publishWorkspaceEvent(this.mediator, evt);
    }
  }
}
