import { z } from "zod";
import type { SetCurrentWorkspaceCommand } from "../commands/set-current-workspace.command.js";
import { CommandValidationError, type CommandValidator } from "./command-validator.js";

const SetCurrentWorkspaceSchema = z.object({
  id: z.string().uuid("workspace id must be a UUID"),
});

export class SetCurrentWorkspaceCommandValidator
  implements CommandValidator<SetCurrentWorkspaceCommand>
{
  async validate(cmd: SetCurrentWorkspaceCommand): Promise<void> {
    const result = SetCurrentWorkspaceSchema.safeParse(cmd);
    if (!result.success) {
      throw new CommandValidationError("SetCurrentWorkspaceCommand", result.error.issues);
    }
  }
}
