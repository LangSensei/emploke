import path from "node:path";
import { inject, injectable } from "inversify";
import { z } from "zod";
import { WorkspaceId } from "../../domain/aggregates/workspace/value-objects/workspace-id.js";
import { WorkspaceRepository } from "../../domain/aggregates/workspace/workspace-repository.js";
import {
  WorkspaceIdConflictError,
  WorkspaceIdInvalidError,
  WorkspaceNameInvalidError,
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
 * Pre-check shape AND uniqueness for RegisterWorkspaceCommand. Runs
 * outside the transactional scope. Failed shape checks throw the
 * typed Phase-1 domain errors (WorkspaceNameInvalidError /
 * WorkspaceIdInvalidError) so the wire layer's 4xx mapping is
 * preserved. Conflict pre-checks throw the typed conflict errors
 * the wire layer maps to 409.
 */
@injectable()
export class RegisterWorkspaceCommandValidator
  implements CommandValidator<RegisterWorkspaceCommand>
{
  constructor(@inject(WorkspaceRepository) private readonly repo: WorkspaceRepository) {}

  async validate(cmd: RegisterWorkspaceCommand): Promise<void> {
    const result = RegisterWorkspaceSchema.safeParse(cmd);
    if (!result.success) {
      // Map specific Zod issues to typed domain errors that the wire
      // layer already knows how to map.
      for (const issue of result.error.issues) {
        const field = issue.path[0];
        if (field === "id") throw new WorkspaceIdInvalidError(cmd.id);
        if (field === "name")
          throw new WorkspaceNameInvalidError(cmd.name, "must be non-empty and at most 255 chars");
      }
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
