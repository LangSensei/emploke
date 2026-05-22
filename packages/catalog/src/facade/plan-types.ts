/**
 * Shared types + the adapter signature used by both `CatalogService`
 * (writes/install) and `CatalogService` (resolves). Pulled out so
 * neither class needs to import the other.
 */

import type { AgentResolvedNode } from "../agent/agent-service.js";
import type { SkillResolvedNode } from "../skill/skill-service.js";

export type PlanNodeDisposition =
  | "new"
  | "will-sync"
  | "up-to-date"
  | "identity-changed"
  | "removed";

export type CatalogPlanNode =
  | {
      kind: "mcp";
      node: McpResolvedNode;
      disposition?: PlanNodeDisposition;
      identityChange?: { oldFqn: string; newFqn: string };
      wasAlreadyInstalled?: boolean;
    }
  | {
      kind: "skill";
      node: SkillResolvedNode;
      disposition?: PlanNodeDisposition;
      identityChange?: { oldFqn: string; newFqn: string };
      wasAlreadyInstalled?: boolean;
    }
  | {
      kind: "agent";
      node: AgentResolvedNode;
      disposition?: PlanNodeDisposition;
      identityChange?: { oldFqn: string; newFqn: string };
      wasAlreadyInstalled?: boolean;
    };

export interface McpResolvedNode {
  readonly fqn: string;
  readonly origin: string;
  readonly content: string;
}

export type CatalogConflict = {
  readonly kind: "mcp" | "skill" | "agent";
  readonly origin: string;
  readonly fqn: string | null;
  readonly reason:
    | { kind: "fetch-failed"; cause: unknown }
    | { kind: "parse-failed"; cause: unknown }
    | { kind: "origin-conflict"; existingOrigin: string };
};

export interface OrphanedEntry {
  readonly kind: "skill" | "mcp";
  readonly fqn: string;
  readonly origin: string;
}

export interface CatalogPlan {
  readonly toInstall: readonly CatalogPlanNode[];
  readonly alreadyInstalled: readonly CatalogPlanNode[];
  readonly conflicts: readonly CatalogConflict[];
  readonly rootOrigin: string;
  readonly isSync: boolean;
  readonly identityChange?: {
    kind: "skill" | "agent" | "mcp";
    oldFqn: string;
    newFqn: string;
  };
  readonly orphans: readonly OrphanedEntry[];
  readonly upToDate: boolean;
}

export type McpResolveAdapter = (origin: string) => Promise<{
  node: McpResolvedNode | null;
  conflict: CatalogConflict | null;
}>;

// ─── Install result shapes ───────────────────────────────

export interface CatalogInstalledEntry {
  readonly kind: "mcp" | "skill" | "agent";
  readonly fqn: string;
  readonly prereqs?: string;
  readonly prereqsAck?: boolean;
}

export interface CatalogInstallFailure {
  readonly kind: "mcp" | "skill" | "agent";
  readonly fqn: string;
  readonly error: { readonly name: string; readonly message: string };
}

export interface CatalogInstallSkip {
  readonly kind: "mcp" | "skill" | "agent";
  readonly fqn: string;
  readonly reason: "already-installed" | "dep-failed" | "up-to-date";
}

export interface CatalogInstallResult {
  readonly installed: readonly CatalogInstalledEntry[];
  readonly skipped: readonly CatalogInstallSkip[];
  readonly failed: readonly CatalogInstallFailure[];
}

export interface CatalogSyncResult extends CatalogInstallResult {
  readonly orphansFlagged: readonly OrphanedEntry[];
}
