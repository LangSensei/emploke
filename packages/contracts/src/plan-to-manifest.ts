/**
 * Wire shape consumed by the dashboard's `ResolveTree` component for
 * the install + sync flows. Lives in `@emploke/contracts` so both the
 * server's `planToManifest` projection AND the dashboard / CLI
 * clients can typecheck against the same shape without one package
 * value-importing the other.
 *
 * Two-phase install + sync flow:
 *  - Install: dashboard POSTs `/skills/resolve` with `{ origin }` to
 *    preview, then `/skills` to commit.
 *  - Sync: dashboard POSTs `/skills/:fqn/sync/resolve` to preview the
 *    diff for an already-installed entry, then `/skills/:fqn/sync` to
 *    commit. Manifest's `isSync` distinguishes the two flows so the
 *    dashboard can render orphans + identity-change banners only when
 *    they're meaningful.
 *
 * Without this projection, dashboard reads `manifest.nodes` on the raw
 * `CatalogPlan` (which has `toInstall`/`alreadyInstalled`/`conflicts`
 * instead) — that triggers a `findIndex` on `undefined` and the React
 * tree unmounts to a blank page.
 */
export interface ResolveManifest {
  readonly rootOrigin: string;
  readonly rootFqn: string;
  /** True iff this manifest was produced via a sync resolve, not a fresh install. */
  readonly isSync: boolean;
  /**
   * Single-use token returned only by sync resolves. Carries the
   * preview-time `CatalogPlan` server-side; the dashboard ships this
   * back on `POST .../sync` so the apply step replays the exact plan
   * the user just previewed instead of doing a fresh re-resolve. TTL
   * is server-controlled (currently 5 minutes).
   *
   * Absent on install resolves — the install path takes an origin and
   * is naturally idempotent.
   */
  readonly planToken?: string;
  /**
   * True iff this is a sync, the root and all transitive deps are
   * unchanged upstream, and no orphan candidates were detected. The
   * dashboard renders "Already up to date" and disables apply.
   */
  readonly upToDate: boolean;
  /**
   * Set when the upstream `fqn` differs from the local row's `fqn`
   * (rename / scope move). The dashboard surfaces this as a distinct
   * "this is effectively a new entry" confirmation step.
   */
  readonly identityChange?: {
    readonly kind: "skill" | "agent" | "mcp";
    readonly oldFqn: string;
    readonly newFqn: string;
  };
  /**
   * Sync-only: deps the new closure dropped that have no remaining
   * reverse-deps. They will be flagged `orphaned` (kept on disk) when
   * the user applies the sync.
   */
  readonly orphans: readonly OrphanManifestEntry[];
  readonly nodes: readonly ResolveManifestNode[];
}

export interface OrphanManifestEntry {
  readonly kind: "skill" | "mcp";
  readonly fqn: string;
  readonly origin: string;
}

interface BaseNode {
  readonly kind: "skill" | "agent" | "mcp";
  readonly origin: string;
  readonly fqn: string;
  readonly status:
    | "new"
    | "will-sync"
    | "already-installed"
    | "up-to-date"
    | "identity-changed"
    | "would-conflict"
    | "fetch-failed"
    | "parse-failed";
  /** Origin URIs of dep entries (post-rename: dep refs ARE origins). */
  readonly depFqns: readonly string[];
  readonly identityChange?: { readonly oldFqn: string; readonly newFqn: string };
  readonly error?: { readonly name: string; readonly message: string };
}

export interface SkillManifestNode extends BaseNode {
  readonly kind: "skill";
  readonly shortName: string;
  readonly scope: string;
  /** Always false post-rename: scope is part of fqn and never inferred. */
  readonly scopeIsDefault: boolean;
}
export interface AgentManifestNode extends BaseNode {
  readonly kind: "agent";
  readonly shortName: string;
  readonly scope: string;
  readonly scopeIsDefault: boolean;
}
export interface McpManifestNode extends BaseNode {
  readonly kind: "mcp";
  readonly specName: string;
}
export type ResolveManifestNode = SkillManifestNode | AgentManifestNode | McpManifestNode;
