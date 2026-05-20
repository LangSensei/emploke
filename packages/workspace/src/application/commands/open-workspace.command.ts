import { RequestData } from "mediatr-ts";

/**
 * Command payload: mark a workspace as just-opened. Updates the
 * aggregate's `lastOpenedAt` timestamp; the workspace with the
 * highest `lastOpenedAt` becomes what `WorkspaceQueries.getLastOpened`
 * returns (the registry's "current" workspace from the user's POV).
 */
export class OpenWorkspaceCommand extends RequestData<void> {
  constructor(public readonly id: string) {
    super();
  }
}
