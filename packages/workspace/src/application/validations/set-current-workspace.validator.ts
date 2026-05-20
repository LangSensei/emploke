import { injectable } from "inversify";
import { z } from "zod";
import { WorkspaceId } from "../../domain/aggregates/workspace/value-objects/workspace-id.js";
import { SetCurrentWorkspaceCommand } from "../commands/set-current-workspace.command.js";
import { CommandValidationError, CommandValidator } from "./command-validator.js";

/** Shape-only — UUID rule lives on `WorkspaceId`. */
const SetCurrentWorkspaceSchema = z.object({
  id: z.string(),
});

@injectable()
export class SetCurrentWorkspaceCommandValidator extends CommandValidator<SetCurrentWorkspaceCommand> {
  readonly command = SetCurrentWorkspaceCommand;

  async validate(cmd: SetCurrentWorkspaceCommand): Promise<void> {
    const result = SetCurrentWorkspaceSchema.safeParse(cmd);
    if (!result.success) {
      throw new CommandValidationError("SetCurrentWorkspaceCommand", result.error.issues);
    }
    WorkspaceId.assertValid(cmd.id);
  }
}
