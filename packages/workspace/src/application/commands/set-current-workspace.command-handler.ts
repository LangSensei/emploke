import { inject, injectable } from "inversify";
import type { RequestHandler } from "mediatr-ts";
import { WorkspaceId } from "../../domain/value-objects/workspace-id.js";
import { WorkspaceRepository } from "../../domain/workspace-repository.js";
import type { SetCurrentWorkspaceCommand } from "./set-current-workspace.command.js";

/**
 * Handle {@link SetCurrentWorkspaceCommand}: forward to the
 * repository's `setCurrent` (which validates the workspace exists +
 * persists the cross-workspace pointer in `global_state`).
 *
 * Does NOT publish a domain event — the current-workspace pointer is
 * not aggregate state (P1-5: it's CLI session state that happens to
 * live in the workspace pkg today). When P1-5 moves the storage out,
 * this handler disappears entirely.
 */
@injectable()
export class SetCurrentWorkspaceCommandHandler
  implements RequestHandler<SetCurrentWorkspaceCommand, void>
{
  constructor(@inject(WorkspaceRepository) private readonly repo: WorkspaceRepository) {}

  async handle(cmd: SetCurrentWorkspaceCommand): Promise<void> {
    const id = WorkspaceId.of(cmd.id);
    await this.repo.setCurrent(id);
  }
}
