import path from "node:path";
import { inject, injectable } from "inversify";
import { z } from "zod";
import { WorkspaceId } from "../../domain/aggregates/workspace/value-objects/workspace-id.js";
import { WorkspaceRepository } from "../../domain/aggregates/workspace/workspace-repository.js";
import {
  WorkspaceIdConflictError,
  WorkspacePathConflictError,
} from "../../domain/exceptions/workspace-errors.js";
import type { RegisterWorkspaceCommand } from "../commands/register-workspace.command.js";
import { CommandValidationError, type CommandValidator } from "./command-validator.js";

const RegisterWorkspaceSchema = z.object({
  id: z.string().uuid("workspace id must be a UUID"),
  name: z
    .string()
    .trim()
    .min(1, "workspace name cannot be empty")
    .max(255, "workspace name cannot exceed 255 chars"),
  workspaceDir: z
    .string()
    .min(1, "workspaceDir cannot be empty")
    .refine((p) => path.isAbsolute(p), "workspaceDir must be an absolute path"),
});

/**
 * Pre-check shape AND uniqueness for {@link RegisterWorkspaceCommand}.
 * Runs outside the transactional scope (ValidationBehavior is the
 * outermost pipeline behaviour) so failures throw without ever
 * opening BEGIN. With this pre-check in place, the SQL UNIQUE
 * constraint becomes a TOCTOU safety net - the repository no longer
 * translates the violation, accepting a 500 in the extremely
 * unlikely race window (single-user emploke).
 */
@injectable()
export class RegisterWorkspaceCommandValidator
  implements CommandValidator<RegisterWorkspaceCommand>
{
  constructor(@inject(WorkspaceRepository) private readonly repo: WorkspaceRepository) {}

  async validate(cmd: RegisterWorkspaceCommand): Promise<void> {
    const result = RegisterWorkspaceSchema.safeParse(cmd);
    if (!result.success) {
      throw new CommandValidationError("RegisterWorkspaceCommand", result.error.issues);
    }

    // Business pre-check: id + path uniqueness
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
