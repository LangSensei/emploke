/**
 * Port interfaces consumed by @emploke/task. Defined here (not imported
 * from the catalog package) so this package depends on catalog only by
 * structural typing — any object satisfying these shapes works. Mirrors
 * the established pattern in @emploke/runtime (cf. runtime/src/types.ts:1-15).
 *
 * Catalog's CatalogService, AgentResolveResult, BlockedReason,
 * etc. satisfy these interfaces structurally; passing catalog values
 * through type-checks without any adapter layer.
 *
 * Not-found discrimination is via `null` return from `getAgentEntry`,
 * NEVER via `instanceof CatalogAgentNotFoundError`. See README / Decision #9.
 */

import type { ResolvedAgent } from "@emploke/runtime";

export interface AgentEntry {
  readonly status: "ready" | "blocked";
  readonly blockedReason?: BlockedReason | undefined;
}

export interface BlockedReason {
  readonly needsPrereqsAck?: true;
  readonly disabledByUser?: true;
  readonly orphaned?: true;
  readonly missingDeps?: readonly MissingDep[];
  readonly blockedDeps?: readonly BlockedDep[];
}

/**
 * Empty (index-only). `summariseReason` reads `.length` only —
 * structural-typing accepts any object, so catalog's wider
 * `{ kind: DependencyKind, name: string }` satisfies this without
 * having to list those fields here.
 */
// biome-ignore lint/complexity/noBannedTypes: see jsdoc above — accepting "any object" is the structural-port contract.
export type MissingDep = {};

/** summariseReason reads `d.fqn`. Catalog's wider `{ kind, fqn }` satisfies. */
export interface BlockedDep {
  readonly fqn: string;
}

export interface AgentResolverPort {
  getAgentEntry(name: string): Promise<AgentEntry | null>;
  resolveAgent(name: string): Promise<ResolvedAgent>;
}
