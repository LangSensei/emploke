import { injectable } from "inversify";
import { z } from "zod";
import { WorkspaceId } from "../../domain/aggregates/workspace/workspace-id.js";
import { WorkspaceName } from "../../domain/aggregates/workspace/workspace-name.js";
import { RenameWorkspaceCommand } from "../commands/rename-workspace.command.js";
import { CommandValidationError, CommandValidator } from "./command-validator.js";

/** Shape-only — strict rules live on the value objects. */
const RenameWorkspaceSchema = z.object({
  id: z.string(),
  newName: z.string().max(1000, "newName payload too large"),
});

@injectable()
export class RenameWorkspaceCommandValidator extends CommandValidator<RenameWorkspaceCommand> {
  readonly command = RenameWorkspaceCommand;

  async validate(cmd: RenameWorkspaceCommand): Promise<void> {
    const result = RenameWorkspaceSchema.safeParse(cmd);
    if (!result.success) {
      throw new CommandValidationError("RenameWorkspaceCommand", result.error.issues);
    }
    WorkspaceId.assertValid(cmd.id);
    WorkspaceName.assertValid(cmd.newName);
  }
}
