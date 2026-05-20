import { RequestData } from "mediatr-ts";

/**
 * Command payload: register a brand-new workspace.
 *
 * Fields are wire-shape strings (not value objects) because the
 * command is the API the wire layer (HTTP routes / CLI commands)
 * targets directly. The command handler converts them to value
 * objects via `WorkspaceId.of` / `WorkspaceName.of` / `WorkspaceDir.of`
 * — those factories surface typed validation errors the wire layer
 * already knows how to map.
 *
 * Returns `{ id }` so callers that auto-generate the id (server route
 * mints a UUID when the user didn't supply one) can read back the
 * canonical id without a second round trip.
 */
export class RegisterWorkspaceCommand extends RequestData<{ id: string }> {
  constructor(
    public readonly id: string,
    public readonly workspaceDir: string,
    public readonly name: string,
  ) {
    super();
  }
}
