import path from "node:path";
import { inject, injectable } from "inversify";
import { z } from "zod";
import { WorkspaceId } from "../../domain/aggregates/workspace/workspace-id.js";
import { WorkspaceName } from "../../domain/aggregates/workspace/workspace-name.js";
import { WorkspaceRepository } from "../../domain/aggregates/workspace/workspace-repository.js";
import {
  WorkspaceIdConflictError,
  WorkspacePathConflictError,
} from "../../domain/exceptions/workspace-errors.js";
import { RegisterWorkspaceCommand } from "../commands/register-workspace.command.js";
import { CommandValidationError, CommandValidator } from "./command-validator.js";

/**
 * Shape-only schema. Field-level business rules (UUID format, display
 * name 1-64 chars w/o control chars) live as the single source of
 * truth on the value objects (`WorkspaceId.assertValid`,
 * `WorkspaceName.assertValid`) and are invoked below. The Zod schema
 * just guards types, presence, and an anti-DoS upper bound.
 */
const RegisterWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string().max(1000, "workspace name payload too large"),
  workspaceDir: z
    .string()
    .min(1, "workspaceDir cannot be empty")
    .refine((p) => path.isAbsolute(p), "workspaceDir must be an absolute path"),
});

/**
 * Pre-check shape AND uniqueness for RegisterWorkspaceCommand. Runs
 * outside the transactional scope. Field rules delegate to the
 * value objects so there is exactly one definition of "valid id" /
 * "valid display name" in the package.
 */
@injectable()
export class RegisterWorkspaceCommandValidator extends CommandValidator<RegisterWorkspaceCommand> {
  readonly command = RegisterWorkspaceCommand;

  constructor(@inject(WorkspaceRepository) private readonly repo: WorkspaceRepository) {
    super();
  }

  async validate(cmd: RegisterWorkspaceCommand): Promise<void> {
    const result = RegisterWorkspaceSchema.safeParse(cmd);
    if (!result.success) {
      throw new CommandValidationError("RegisterWorkspaceCommand", result.error.issues);
    }

    // Field-level invariants — delegate to value objects.
    WorkspaceId.assertValid(cmd.id);
    WorkspaceName.assertValid(cmd.name);

    // Cross-aggregate pre-checks (uniqueness).
    const existingById = await this.repo.findById(WorkspaceId.of(cmd.id));
    if (existingById) {
      throw new WorkspaceIdConflictError(cmd.id);
    }
    const existingByPath = await this.repo.findByPath(path.resolve(cmd.workspaceDir));
    if (existingByPath) {
      throw new WorkspacePathConflictError(cmd.workspaceDir, existingByPath.id);
    }
  }
}
