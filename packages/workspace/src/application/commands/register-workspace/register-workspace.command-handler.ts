import { mkdir } from "node:fs/promises";
import { inject, injectable } from "inversify";
import type { RequestHandler } from "mediatr-ts";
import { Clock } from "../../../domain/clock.js";
import { WorkspaceDir } from "../../../domain/value-objects/workspace-dir.js";
import { WorkspaceId } from "../../../domain/value-objects/workspace-id.js";
import { WorkspaceName } from "../../../domain/value-objects/workspace-name.js";
import { Workspace } from "../../../domain/workspace.js";
import { WorkspaceRepository } from "../../../domain/workspace-repository.js";
import { workspaceLayout } from "../../../workspace-layout.js";
import type { RegisterWorkspaceCommand } from "./register-workspace.command.js";

/**
 * Handle {@link RegisterWorkspaceCommand}: create the workspace
 * directory + standard subdirs on disk, then hand a fresh
 * {@link Workspace} aggregate to {@link WorkspaceRepository.add}
 * so the next SQL write inserts the registry row.
 *
 * Phase 2 / ADR-3: the handler shed three pieces of plumbing the
 * pre-ADR version owned:
 *
 *   - **`repo.create(ws)`** — gone. The Phase-2 replacement is
 *     `repo.add(ws)`, which wraps `em.persist` + eager flush + typed
 *     conflict translation in a domain-shaped seam. The handler stays
 *     free of `@mikro-orm/core` imports (Pattern B per
 *     `.ceo/design/polish-backlog.md` P1-6) and the
 *     `WorkspaceRepository` contract is now complete: every
 *     handler-visible write path goes through the repository.
 *   - **`pullDomainEvents` + `publishWorkspaceEvent` loop** — gone.
 *     `DomainEventSubscriber.afterFlush` walks the change-set and
 *     dispatches every accumulated event automatically.
 *   - **Manual id / path conflict pre-checks** — collapsed. The
 *     primary key + UNIQUE constraint on `workspace_dir` enforce
 *     uniqueness inside the same transaction MikroORM uses to
 *     insert; `repo.add` translates the resulting SQL exception into
 *     the typed `WorkspaceIdConflictError` / `WorkspacePathConflictError`
 *     the wire layer already maps to HTTP 409.
 *
 * The disk-side `mkdir` calls stay in the handler because they're
 * cross-context concerns (filesystem != database). They run BEFORE
 * `repo.add` so that if the user supplied an unwritable path the
 * registry stays clean.
 */
@injectable()
export class RegisterWorkspaceCommandHandler
  implements RequestHandler<RegisterWorkspaceCommand, { id: string }>
{
  constructor(
    @inject(WorkspaceRepository) private readonly repo: WorkspaceRepository,
    @inject(Clock) private readonly clock: Clock,
  ) {}

  async handle(cmd: RegisterWorkspaceCommand): Promise<{ id: string }> {
    const id = WorkspaceId.of(cmd.id);
    const name = WorkspaceName.of(cmd.name);
    const workspaceDir = WorkspaceDir.of(cmd.workspaceDir);

    // Create the workspace directory + standard subdirs. The user's
    // pre-existing files inside `workspaceDir` are preserved; we only
    // touch the named subdirs. We do this BEFORE handing the aggregate
    // to the repository so the layout is in place by the time the
    // flush commits the registry row.
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
    // `repo.add` owns the eager `em.persist` + `em.flush` + typed
    // conflict translation. The `TransactionBehavior` outer flush
    // becomes a no-op on the now-empty change-set, and
    // `DomainEventSubscriber.afterFlush` still picks up the
    // `WorkspaceRegistered` event from the inner flush.
    await this.repo.add(ws);
    return { id: ws.id };
  }
}
