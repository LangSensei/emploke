/**
 * Re-exports of T0/T1 domain types that cross the HTTP wire.
 *
 * Hosted here so dashboard and CLI can pull every shape they need
 * through `@emploke/contracts` without taking a workspace dep on
 * the underlying domain pkg. Importing the source pkg would let the
 * consumer accidentally pull non-wire surfaces (DB handles, service
 * classes) into its module graph.
 *
 * All re-exports MUST be type-only. Value re-exports belong in
 * `@emploke/api` (the orchestration root), which has fewer caller
 * categories and tighter audit.
 */

export type {
  Agent,
  AgentEntry,
  AgentInstallBody,
  AgentMetadataPatch,
  BlockedReason,
  CatalogInstallResult,
  CatalogKind,
  CatalogSyncResult,
  Mcp,
  McpInstallBody,
  MissingDep,
  Skill,
  SkillEntry,
  SkillInstallBody,
  SkillMetadataPatch,
} from "@emploke/catalog";
export type { ActivityItem, TruncationInfo } from "@emploke/runtime";
export type { PreviewResult, Schedule } from "@emploke/schedule";
export type { Session } from "@emploke/session";
export type { Task, TaskStatus } from "@emploke/task";
