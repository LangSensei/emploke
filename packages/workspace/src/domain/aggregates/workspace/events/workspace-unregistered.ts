import { WorkspaceDomainEvent } from "../../../seedwork/domain-event.js";
import type { WorkspaceId } from "../value-objects/workspace-id.js";

/**
 * Raised by `Workspace.unregister(...)` — the workspace was removed
 * from the registry. Phase 1 has no subscribers; future phases may use
 * this to cascade-clean cross-context state (session / task cleanup).
 */
export class WorkspaceUnregistered extends WorkspaceDomainEvent {
  readonly occurredAt: string;
  readonly id: WorkspaceId;
  readonly purged: boolean;

  constructor(args: {
    id: WorkspaceId;
    purged: boolean;
    unregisteredAt: string;
  }) {
    super();
    this.id = args.id;
    this.purged = args.purged;
    this.occurredAt = args.unregisteredAt;
  }

  /** Alias for `occurredAt`. */
  get unregisteredAt(): string {
    return this.occurredAt;
  }
}
