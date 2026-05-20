import { RequestData } from "mediatr-ts";

/**
 * Command payload: mark a workspace as the "current" selection.
 *
 * NOTE (P1-5 in `.ceo/design/polish-backlog.md`): the
 * `global_state.current_workspace_id` value this command writes is
 * CLI session state, not workspace domain state. Phase 1 keeps it in
 * the workspace pkg's surface for back-compat with the legacy
 * `WorkspaceManager.setCurrent()` HTTP endpoint; a future phase moves
 * the storage out (likely to a CLI-owned preferences table) and
 * deletes this command. Until then it's modeled as a command for
 * consistency with the rest of the CQRS surface.
 */
export class SetCurrentWorkspaceCommand extends RequestData<void> {
  constructor(public readonly id: string) {
    super();
  }
}
