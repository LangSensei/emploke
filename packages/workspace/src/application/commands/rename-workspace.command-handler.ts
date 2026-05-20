import { inject, injectable } from "inversify";
import type { RequestHandler } from "mediatr-ts";
import { WorkspaceId } from "../../domain/aggregates/workspace/workspace-id.js";
import { WorkspaceName } from "../../domain/aggregates/workspace/workspace-name.js";
import { WorkspaceRepository } from "../../domain/aggregates/workspace/workspace-repository.js";
import { WorkspaceNotRegisteredError } from "../../domain/exceptions/workspace-errors.js";
import type { RenameWorkspaceCommand } from "./rename-workspace.command.js";

/**
 * Handle {@link RenameWorkspaceCommand}: fetch the workspace
 * aggregate, call `ws.rename(...)`, and rely on the surrounding
 * `TransactionBehavior`'s `em.flush` to write the UPDATE.
 *
 * The handler does NOT call `repo.save(ws)`: `findById` returns a
 * tracked entity, the rename mutates it in-place, and `em.flush`
 * writes the UPDATE. The aggregate's `rename` is no-op when the new
 * name equals the current one — UoW change-set is empty so the flush
 * makes no SQL round-trip.
 *
 * Throws `WorkspaceNotRegisteredError` when no workspace with the
 * given id exists.
 */
@injectable()
export class RenameWorkspaceCommandHandler implements RequestHandler<RenameWorkspaceCommand, void> {
  constructor(@inject(WorkspaceRepository) private readonly repo: WorkspaceRepository) {}

  async handle(cmd: RenameWorkspaceCommand): Promise<void> {
    const id = WorkspaceId.of(cmd.id);
    const newName = WorkspaceName.of(cmd.newName);

    const ws = await this.repo.findById(id);
    if (!ws) throw new WorkspaceNotRegisteredError(id.value);

    ws.rename(newName);
  }
}
