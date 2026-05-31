/**
 * Per-domain error policy for the catalog routes
 * (`catalog/agents.ts`, `catalog/skills.ts`, `catalog/mcps.ts`).
 *
 * Source of truth for the (class, status) pairs is the pre-refactor
 * `statusForCatalogError` switch in `_shared.ts`. That switch keyed
 * off `err.name` for historical reasons; the policy here uses
 * `instanceof` against the concrete classes so adding a new typed
 * error class without updating the policy is a TypeScript-visible
 * change, not a silent name-string drift.
 *
 * `defaultStatus: 500` preserves the pre-refactor catalog catch
 * blocks' `?? 500` fallback — unknown catalog errors are server faults
 * (something deep inside the resolver / fetcher / writer broke).
 *
 * The catalog-package `AgentNotFoundError` is a distinct class from
 * the task / schedule / session variants; this policy
 * `instanceof`-matches the catalog class so a catalog route returns
 * 404 while the same name from another domain returns 400 on its own
 * routes (see the commit-3 contract test).
 */

import {
  AgentFrontmatterError,
  AgentNameInvalidError,
  AgentNotFoundError,
  AgentOriginConflictError,
  AgentPlanStaleError,
  CyclicDependencyError,
  FetchError,
  HasDependentsError,
  ImmutableOriginError,
  McpInvalidJsonError,
  McpNameInvalidError,
  McpNotFoundError,
  McpOriginConflictError,
  OriginParseError,
  PlanStaleError,
  SkillFrontmatterError,
  SkillNameInvalidError,
  SkillNotFoundError,
  SkillOriginConflictError,
} from "@emploke/catalog";
import type { ErrorPolicy } from "../_respond-error.js";

export const catalogErrorPolicy: ErrorPolicy = {
  name: "catalog",
  defaultStatus: 500,
  statuses: [
    // 400 — caller-fixable input.
    [SkillNameInvalidError, 400],
    [AgentNameInvalidError, 400],
    [McpNameInvalidError, 400],
    [SkillFrontmatterError, 400],
    [AgentFrontmatterError, 400],
    [McpInvalidJsonError, 400],
    [OriginParseError, 400],
    [PlanStaleError, 400],
    [AgentPlanStaleError, 400],
    [CyclicDependencyError, 400],

    // 404 — entity not in the catalog.
    [SkillNotFoundError, 404],
    [AgentNotFoundError, 404],
    [McpNotFoundError, 404],

    // 405 — mutation against a read-only origin.
    [ImmutableOriginError, 405],

    // 409 — state conflict.
    [HasDependentsError, 409],
    [SkillOriginConflictError, 409],
    [AgentOriginConflictError, 409],
    [McpOriginConflictError, 409],

    // 502 — downstream fetch failed.
    [FetchError, 502],
  ],
};
