import { WorkspaceDomainEvent } from "../../../seedwork/domain-event.js";
import type { WorkspaceId } from "../value-objects/workspace-id.js";
import type { WorkspaceName } from "../value-objects/workspace-name.js";

/**
 * Raised by `Workspace.rename(...)` — the workspace's display name
 * changed. Only raised when the new name differs from the previous one
 * (no-op renames are dropped at the aggregate level).
 */
export class WorkspaceRenamed extends WorkspaceDomainEvent {
  readonly occurredAt: string;
  readonly id: WorkspaceId;
  readonly oldName: WorkspaceName;
  readonly newName: WorkspaceName;

  constructor(args: {
    id: WorkspaceId;
    oldName: WorkspaceName;
    newName: WorkspaceName;
    renamedAt: string;
  }) {
    super();
    this.id = args.id;
    this.oldName = args.oldName;
    this.newName = args.newName;
    this.occurredAt = args.renamedAt;
  }

  /** Alias for `occurredAt`. */
  get renamedAt(): string {
    return this.occurredAt;
  }
}
