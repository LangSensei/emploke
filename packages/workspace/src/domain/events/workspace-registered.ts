import type { WorkspaceDir } from "../value-objects/workspace-dir.js";
import type { WorkspaceId } from "../value-objects/workspace-id.js";
import type { WorkspaceName } from "../value-objects/workspace-name.js";
import { WorkspaceDomainEvent } from "./domain-event.js";

/**
 * Raised by `Workspace.register(...)` — a fresh workspace was minted.
 */
export class WorkspaceRegistered extends WorkspaceDomainEvent {
  readonly occurredAt: string;
  readonly id: WorkspaceId;
  readonly name: WorkspaceName;
  readonly workspaceDir: WorkspaceDir;

  constructor(args: {
    id: WorkspaceId;
    name: WorkspaceName;
    workspaceDir: WorkspaceDir;
    registeredAt: string;
  }) {
    super();
    this.id = args.id;
    this.name = args.name;
    this.workspaceDir = args.workspaceDir;
    this.occurredAt = args.registeredAt;
  }

  /** Alias for `occurredAt` (matches the registration semantic). */
  get registeredAt(): string {
    return this.occurredAt;
  }
}
