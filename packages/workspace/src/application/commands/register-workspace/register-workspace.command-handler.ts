import { mkdir } from "node:fs/promises";
import { EntityManager, UniqueConstraintViolationException } from "@mikro-orm/core";
import { inject, injectable } from "inversify";
import type { RequestHandler } from "mediatr-ts";
import { Clock } from "../../../domain/clock.js";
import { WorkspaceIdConflictError, WorkspacePathConflictError } from "../../../domain/errors.js";
import { WorkspaceDir } from "../../../domain/value-objects/workspace-dir.js";
import { WorkspaceId } from "../../../domain/value-objects/workspace-id.js";
import { WorkspaceName } from "../../../domain/value-objects/workspace-name.js";
import { Workspace } from "../../../domain/workspace.js";
import { workspaceLayout } from "../../../workspace-layout.js";
import type { RegisterWorkspaceCommand } from "./register-workspace.command.js";

/**
 * Handle {@link RegisterWorkspaceCommand}: create the workspace
 * directory + standard subdirs on disk, then enroll a fresh
 * {@link Workspace} aggregate with the EntityManager so the next
 * flush writes the INSERT.
 *
 * Phase 2 / ADR-3: the handler shed three pieces of plumbing the
 * pre-ADR version owned:
 *
 *   - **`repo.create(ws)`** — gone. `em.persist(ws)` enrolls the
 *     entity in the unit-of-work; the flush at the end of the
 *     pipeline (driven by `TransactionBehavior`) writes the INSERT.
 *   - **`pullDomainEvents` + `publishWorkspaceEvent` loop** — gone.
 *     `DomainEventSubscriber.afterFlush` walks the change-set and
 *     dispatches every accumulated event automatically.
 *   - **Manual id / path conflict pre-checks** — collapsed. The
 *     primary key + UNIQUE constraint on `workspace_dir` enforce
 *     uniqueness inside the same transaction MikroORM uses to
 *     insert; we translate the resulting
 *     {@link UniqueConstraintViolationException} into the typed
 *     {@link WorkspaceIdConflictError} /
 *     {@link WorkspacePathConflictError} the wire layer already
 *     maps to HTTP 409.
 *
 * The disk-side `mkdir` calls stay in the handler because they're
 * cross-context concerns (filesystem != database). They run BEFORE
 * `em.persist` so that if the user supplied an unwritable path the
 * registry stays clean.
 */
@injectable()
export class RegisterWorkspaceCommandHandler
  implements RequestHandler<RegisterWorkspaceCommand, { id: string }>
{
  constructor(
    @inject(EntityManager) private readonly em: EntityManager,
    @inject(Clock) private readonly clock: Clock,
  ) {}

  async handle(cmd: RegisterWorkspaceCommand): Promise<{ id: string }> {
    const id = WorkspaceId.of(cmd.id);
    const name = WorkspaceName.of(cmd.name);
    const workspaceDir = WorkspaceDir.of(cmd.workspaceDir);

    // Create the workspace directory + standard subdirs. The user's
    // pre-existing files inside `workspaceDir` are preserved; we only
    // touch the named subdirs. We do this BEFORE persisting the
    // aggregate so the layout is in place by the time the flush
    // commits the registry row.
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
    try {
      this.em.persist(ws);
      // The flush is driven by `TransactionBehavior`'s
      // `em.transactional` wrapper, which ALSO triggers
      // `DomainEventSubscriber.afterFlush` for the
      // `WorkspaceRegistered` event the aggregate raised.
      await this.em.flush();
    } catch (err) {
      // Translate the SQL-level UNIQUE violation into the typed
      // domain error the wire layer maps to 409. MikroORM v6
      // surfaces the constraint name in `err.message`; we sniff for
      // the column name we own ("workspace_dir") to distinguish
      // path-conflict from id-conflict. PRIMARY KEY (`id`) violations
      // don't carry the column name in every driver, so the fallback
      // is `WorkspaceIdConflictError`.
      if (err instanceof UniqueConstraintViolationException) {
        const msg = err.message.toLowerCase();
        if (msg.includes("workspace_dir")) {
          throw new WorkspacePathConflictError(workspaceDir.value, "<unknown>");
        }
        throw new WorkspaceIdConflictError(id.value);
      }
      throw err;
    }
    return { id: ws.id };
  }
}
