import type { CatalogConflict, CatalogPlan, CatalogPlanNode } from "@emploke/catalog";

/**
 * Wire shape consumed by the dashboard's `ResolveTree` component
 * (`packages/dashboard/src/api.ts:ResolveManifest`). Mirrored here so
 * the server route can project a `CatalogPlan` into the response shape
 * the dashboard expects without dragging a dashboard-package import.
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

interface SkillManifestNode extends BaseNode {
  readonly kind: "skill";
  readonly shortName: string;
  readonly scope: string;
  /** Always false post-rename: scope is part of fqn and never inferred. */
  readonly scopeIsDefault: boolean;
}
interface AgentManifestNode extends BaseNode {
  readonly kind: "agent";
  readonly shortName: string;
  readonly scope: string;
  readonly scopeIsDefault: boolean;
}
interface McpManifestNode extends BaseNode {
  readonly kind: "mcp";
  readonly specName: string;
}
export type ResolveManifestNode = SkillManifestNode | AgentManifestNode | McpManifestNode;

/**
 * Project a `CatalogPlan` into the dashboard wire shape.
 *
 * `rootOrigin` is read from the plan itself (set at resolve time —
 * the user-supplied install origin or the local row's origin for
 * sync). The matching node's fqn (if found in the plan) becomes
 * `rootFqn`; if the input origin is in the conflicts bucket
 * (e.g. relative path → fetch-failed), `rootFqn` falls back to
 * empty string so the dashboard's "n nodes to install" header
 * still renders.
 *
 * `planToken` is sync-only and threaded through by the route layer
 * (after caching the plan); install-resolve callers pass `undefined`.
 */
export function planToManifest(plan: CatalogPlan, planToken?: string): ResolveManifest {
  const nodes: ResolveManifestNode[] = [];
  for (const planNode of plan.toInstall) {
    nodes.push(planNodeToManifest(planNode, statusFromDisposition(planNode)));
  }
  for (const planNode of plan.alreadyInstalled) {
    nodes.push(
      planNodeToManifest(
        planNode,
        planNode.disposition === "up-to-date" ? "up-to-date" : "already-installed",
      ),
    );
  }
  for (const conflict of plan.conflicts) {
    nodes.push(conflictToManifest(conflict));
  }

  const rootNode = nodes.find((n) => n.origin === plan.rootOrigin);
  return {
    rootOrigin: plan.rootOrigin,
    rootFqn: rootNode?.fqn ?? "",
    isSync: plan.isSync,
    upToDate: plan.upToDate,
    ...(planToken !== undefined ? { planToken } : {}),
    ...(plan.identityChange !== undefined ? { identityChange: plan.identityChange } : {}),
    orphans: plan.orphans.map((o) => ({ kind: o.kind, fqn: o.fqn, origin: o.origin })),
    nodes,
  };
}

function statusFromDisposition(
  planNode: CatalogPlanNode,
): "new" | "will-sync" | "identity-changed" {
  switch (planNode.disposition) {
    case "identity-changed":
      return "identity-changed";
    case "will-sync":
      return "will-sync";
    case "new":
    case undefined:
    case "removed": // shouldn't occur in toInstall, but be defensive
    case "up-to-date":
      // up-to-date / new fall through to the legacy logic that uses
      // wasAlreadyInstalled to pick the label.
      return planNode.wasAlreadyInstalled === true ? "will-sync" : "new";
  }
}

function planNodeToManifest(
  planNode: CatalogPlanNode,
  status: BaseNode["status"],
): ResolveManifestNode {
  const fqn = planNode.node.fqn;
  const identityChange = planNode.identityChange;
  if (planNode.kind === "mcp") {
    return {
      kind: "mcp",
      origin: planNode.node.origin,
      fqn,
      status,
      depFqns: [],
      specName: fqn,
      ...(identityChange ? { identityChange } : {}),
    };
  }
  const [scope, shortName] = splitFqn(fqn);
  const depRefs = planNode.node.depsRefs;
  return {
    kind: planNode.kind,
    origin: planNode.node.origin,
    fqn,
    status,
    depFqns: [...depRefs.skills, ...depRefs.mcps],
    shortName,
    scope,
    scopeIsDefault: false,
    ...(identityChange ? { identityChange } : {}),
  };
}

function conflictToManifest(conflict: CatalogConflict): ResolveManifestNode {
  const status =
    conflict.reason.kind === "fetch-failed"
      ? "fetch-failed"
      : conflict.reason.kind === "parse-failed"
        ? "parse-failed"
        : "would-conflict";
  const fqn = conflict.fqn ?? "";
  const error = errorFromConflict(conflict);
  if (conflict.kind === "mcp") {
    return {
      kind: "mcp",
      origin: conflict.origin,
      fqn,
      status,
      depFqns: [],
      specName: fqn,
      ...(error ? { error } : {}),
    };
  }
  const [scope, shortName] = splitFqn(fqn);
  return {
    kind: conflict.kind,
    origin: conflict.origin,
    fqn,
    status,
    depFqns: [],
    shortName,
    scope,
    scopeIsDefault: false,
    ...(error ? { error } : {}),
  };
}

function splitFqn(fqn: string): [scope: string, shortName: string] {
  const slash = fqn.indexOf("/");
  if (slash < 0) return ["", fqn];
  return [fqn.slice(0, slash), fqn.slice(slash + 1)];
}

function errorFromConflict(
  conflict: CatalogConflict,
): { name: string; message: string } | undefined {
  const r = conflict.reason;
  if (r.kind === "origin-conflict") {
    return {
      name: "OriginConflict",
      message: `already installed under origin ${r.existingOrigin}`,
    };
  }
  const cause = r.cause;
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }
  if (typeof cause === "string") {
    return { name: r.kind, message: cause };
  }
  return { name: r.kind, message: String(cause) };
}
