import { z } from "zod";
import type { UnregisterWorkspaceCommand } from "../commands/unregister-workspace.command.js";
import { CommandValidationError, type CommandValidator } from "./command-validator.js";

const UnregisterWorkspaceSchema = z.object({
  id: z.string().uuid("workspace id must be a UUID"),
  purge: z.boolean(),
});

export class UnregisterWorkspaceCommandValidator
  implements CommandValidator<UnregisterWorkspaceCommand>
{
  async validate(cmd: UnregisterWorkspaceCommand): Promise<void> {
    const result = UnregisterWorkspaceSchema.safeParse(cmd);
    if (!result.success) {
      throw new CommandValidationError("UnregisterWorkspaceCommand", result.error.issues);
    }
  }
}
