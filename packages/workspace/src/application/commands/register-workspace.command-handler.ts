import { mkdir } from "node:fs/promises";
import { inject, injectable } from "inversify";
import type { RequestHandler } from "mediatr-ts";
import { Workspace } from "../../domain/aggregates/workspace/workspace.js";
import { WorkspaceDir } from "../../domain/aggregates/workspace/workspace-dir.js";
import { WorkspaceId } from "../../domain/aggregates/workspace/workspace-id.js";
import { WorkspaceName } from "../../domain/aggregates/workspace/workspace-name.js";
import { WorkspaceRepository } from "../../domain/aggregates/workspace/workspace-repository.js";
import { workspaceLayout } from "../../domain/workspace-layout.js";
import type { RegisterWorkspaceCommand } from "./register-workspace.command.js";

/**
 * Handle RegisterWorkspaceCommand: create the workspace directory +
 * standard subdirs on disk, then hand a fresh Workspace aggregate to
 * WorkspaceRepository.add.
 *
 * Shape + uniqueness pre-checks happen in RegisterWorkspaceCommandValidator
 * (outermost pipeline behaviour, runs before TransactionBehavior opens
 * BEGIN). By the time this handler runs, cmd is shape-valid AND no
 * id/path collision exists in the DB.
 *
 * The disk-side mkdir calls stay in the handler because they are
 * cross-context concerns (filesystem != database). They run BEFORE
 * repo.add so that if the user supplied an unwritable path the
 * registry stays clean.
 */
@injectable()
export class RegisterWorkspaceCommandHandler
  implements RequestHandler<RegisterWorkspaceCommand, { id: string }>
{
  constructor(@inject(WorkspaceRepository) private readonly repo: WorkspaceRepository) {}

  async handle(cmd: RegisterWorkspaceCommand): Promise<{ id: string }> {
    const id = WorkspaceId.of(cmd.id);
    const name = WorkspaceName.of(cmd.name);
    const workspaceDir = WorkspaceDir.of(cmd.workspaceDir);

    await mkdir(workspaceDir.value, { recursive: true });
    const layout = workspaceLayout(workspaceDir.value);
    await Promise.all([
      mkdir(layout.sessions, { recursive: true }),
      mkdir(layout.tasks, { recursive: true }),
    ]);

    const ws = await this.repo.add(
      Workspace.register({ id, name, workspaceDir, now: new Date().toISOString() }),
    );
    return { id: ws.id };
  }
}
