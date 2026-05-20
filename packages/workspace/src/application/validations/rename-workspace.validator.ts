import { z } from "zod";
import {
  WorkspaceIdInvalidError,
  WorkspaceNameInvalidError,
} from "../../domain/exceptions/workspace-errors.js";
import type { RenameWorkspaceCommand } from "../commands/rename-workspace.command.js";
import { CommandValidationError, type CommandValidator } from "./command-validator.js";

const RenameWorkspaceSchema = z.object({
  id: z.string().uuid("workspace id must be a UUID"),
  newName: z
    .string()
    .trim()
    .min(1, "newName cannot be empty")
    .max(255, "newName cannot exceed 255 chars"),
});

export class RenameWorkspaceCommandValidator implements CommandValidator<RenameWorkspaceCommand> {
  async validate(cmd: RenameWorkspaceCommand): Promise<void> {
    const result = RenameWorkspaceSchema.safeParse(cmd);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = issue.path[0];
        if (field === "id") throw new WorkspaceIdInvalidError(cmd.id);
        if (field === "newName")
          throw new WorkspaceNameInvalidError(
            cmd.newName,
            "must be non-empty and at most 255 chars",
          );
      }
      throw new CommandValidationError("RenameWorkspaceCommand", result.error.issues);
    }
  }
}
