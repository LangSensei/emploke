import { inject, injectable } from "inversify";
import type { RequestHandler } from "mediatr-ts";
import { WorkspaceId } from "../../domain/aggregates/workspace/workspace-id.js";
import { WorkspaceRepository } from "../../domain/aggregates/workspace/workspace-repository.js";
import { WorkspaceNotRegisteredError } from "../../domain/exceptions/workspace-errors.js";
import type { OpenWorkspaceCommand } from "./open-workspace.command.js";

/**
 * Handle {@link OpenWorkspaceCommand}: load the aggregate, call
 * `ws.open(now)` (which updates `lastOpenedAt`), and rely on
 * `TransactionBehavior` to flush. Throws
 * {@link WorkspaceNotRegisteredError} when no workspace with the
 * given id exists.
 */
@injectable()
export class OpenWorkspaceCommandHandler implements RequestHandler<OpenWorkspaceCommand, void> {
  constructor(@inject(WorkspaceRepository) private readonly repo: WorkspaceRepository) {}

  async handle(cmd: OpenWorkspaceCommand): Promise<void> {
    const id = WorkspaceId.of(cmd.id);
    const ws = await this.repo.findById(id);
    if (!ws) throw new WorkspaceNotRegisteredError(id.value);
    ws.open(new Date().toISOString());
  }
}
