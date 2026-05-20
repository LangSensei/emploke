import { inject, injectable } from "inversify";
import type { RequestHandler } from "mediatr-ts";
import { WorkspaceId } from "../../domain/aggregates/workspace/value-objects/workspace-id.js";
import { WorkspaceName } from "../../domain/aggregates/workspace/value-objects/workspace-name.js";
import { WorkspaceRepository } from "../../domain/aggregates/workspace/workspace-repository.js";
import { Clock } from "../../domain/clock.js";
import { WorkspaceNotRegisteredError } from "../../domain/exceptions/workspace-errors.js";
import type { RenameWorkspaceCommand } from "./rename-workspace.command.js";

/**
 * Handle {@link RenameWorkspaceCommand}: fetch the workspace
 * aggregate, call `ws.rename(...)`, and rely on the surrounding
 * `TransactionBehavior`'s `em.flush` to write the UPDATE plus
 * dispatch the `WorkspaceRenamed` event.
 *
 * ## What the handler stopped doing (Phase 2 / ADR-3)
 *
 *   - **`repo.save(ws)`** — gone. `findById` returns a tracked
 *     entity; the rename mutates it in-place; `em.flush` writes the
 *     UPDATE automatically.
 *   - **Manual `pullDomainEvents` + publish loop** — gone.
 *     `DomainEventSubscriber.afterFlush` dispatches the event after
 *     the SQL write lands.
 *   - **Explicit no-op short-circuit** — collapsed. The aggregate's
 *     `rename` is still no-op when the new name equals the current
 *     one, but the handler doesn't need a separate `if (events.length
 *     === 0) return` guard because the UoW's change-set is empty when
 *     no field changed: the flush is a free no-op, the subscriber
 *     sees no event to publish, no UPDATE hits SQLite. (Cf. the
 *     pre-Phase-2 handler that needed to skip `repo.save` to avoid an
 *     unnecessary `BEGIN IMMEDIATE`.)
 *
 * Throws `WorkspaceNotRegisteredError` when no workspace with the
 * given id exists.
 */
@injectable()
export class RenameWorkspaceCommandHandler implements RequestHandler<RenameWorkspaceCommand, void> {
  constructor(
    @inject(WorkspaceRepository) private readonly repo: WorkspaceRepository,
    @inject(Clock) private readonly clock: Clock,
  ) {}

  async handle(cmd: RenameWorkspaceCommand): Promise<void> {
    const id = WorkspaceId.of(cmd.id);
    const newName = WorkspaceName.of(cmd.newName);

    const ws = await this.repo.findById(id);
    if (!ws) throw new WorkspaceNotRegisteredError(id.value);

    ws.rename(newName, this.clock.nowIso());
    // No explicit save — `ws` is tracked; em.flush() in
    // TransactionBehavior writes UPDATE. No publish loop — the
    // DomainEventSubscriber dispatches WorkspaceRenamed if one was
    // raised.
  }
}
