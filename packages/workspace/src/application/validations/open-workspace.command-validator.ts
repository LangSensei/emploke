import { injectable } from "inversify";
import { z } from "zod";
import { WorkspaceId } from "../../domain/aggregates/workspace/workspace-id.js";
import { OpenWorkspaceCommand } from "../commands/open-workspace.command.js";
import { CommandValidationError, CommandValidator } from "./command-validator.js";

/** Shape-only  UUID rule lives on `WorkspaceId`. */
const OpenWorkspaceSchema = z.object({
  id: z.string(),
});

@injectable()
export class OpenWorkspaceCommandValidator extends CommandValidator<OpenWorkspaceCommand> {
  readonly command = OpenWorkspaceCommand;

  async validate(cmd: OpenWorkspaceCommand): Promise<void> {
    const result = OpenWorkspaceSchema.safeParse(cmd);
    if (!result.success) {
      throw new CommandValidationError("OpenWorkspaceCommand", result.error.issues);
    }
    WorkspaceId.assertValid(cmd.id);
  }
}
