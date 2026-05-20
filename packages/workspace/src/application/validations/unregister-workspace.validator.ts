import { injectable } from "inversify";
import { z } from "zod";
import { WorkspaceId } from "../../domain/aggregates/workspace/value-objects/workspace-id.js";
import { UnregisterWorkspaceCommand } from "../commands/unregister-workspace.command.js";
import { CommandValidationError, CommandValidator } from "./command-validator.js";

/** Shape-only — UUID rule lives on `WorkspaceId`. */
const UnregisterWorkspaceSchema = z.object({
  id: z.string(),
  purge: z.boolean(),
});

@injectable()
export class UnregisterWorkspaceCommandValidator extends CommandValidator<UnregisterWorkspaceCommand> {
  readonly command = UnregisterWorkspaceCommand;

  async validate(cmd: UnregisterWorkspaceCommand): Promise<void> {
    const result = UnregisterWorkspaceSchema.safeParse(cmd);
    if (!result.success) {
      throw new CommandValidationError("UnregisterWorkspaceCommand", result.error.issues);
    }
    WorkspaceId.assertValid(cmd.id);
  }
}
