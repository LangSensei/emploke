import { RequestData } from "mediatr-ts";

/**
 * Command payload: unregister a workspace.
 *
 * `purge=true` additionally rm-rfs every emploke-owned subdirectory
 * under the workspace's `workspaceDir` (`sessions/`, `tasks/`). The
 * `workspaceDir` itself is **never** removed — it is user-owned and
 * may contain files emploke does not know about. Default `false`:
 * only the workspace metadata is removed; agent artifacts survive
 * deletion. The dashboard surfaces the choice as an explicit checkbox.
 */
export class UnregisterWorkspaceCommand extends RequestData<void> {
  constructor(
    public readonly id: string,
    public readonly purge: boolean = false,
  ) {
    super();
  }
}
