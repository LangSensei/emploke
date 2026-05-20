import { z } from "zod";
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
      throw new CommandValidationError("RenameWorkspaceCommand", result.error.issues);
    }
  }
}
