import type { CatalogConflict, CatalogPlan, CatalogPlanNode } from "@emploke/catalog";

/**
 * Wire shape consumed by the dashboard's `ResolveTree` component
 * (`packages/dashboard/src/api.ts:ResolveManifest`). Mirrored here so
 * the server route can project a `CatalogPlan` into the response shape
 * the dashboard expects without dragging a dashboard-package import.
 *
 * Two-phase install flow:
 *  - dashboard POSTs `/skills/resolve` (or `/agents/resolve`) with
 *    `{ origin }` to preview the install
 *  - server resolves to a `CatalogPlan`, then projects via
 *    {@link planToManifest} so the dashboard can render
 *    `ResolveTree.tsx` (which reads `manifest.nodes`).
 *
 * Without this projection, dashboard reads `manifest.nodes` on the raw
 * `CatalogPlan` (which has `toInstall`/`alreadyInstalled`/`conflicts`
 * instead) — that triggers a `findIndex` on `undefined` and the React
 * tree unmounts to a blank page.
 */
export interface ResolveManifest {
  readonly rootOrigin: string;
  readonly rootFqn: string;
  readonly nodes: readonly ResolveManifestNode[];
}

interface BaseNode {
  readonly kind: "skill" | "agent" | "mcp";
  readonly origin: string;
  readonly fqn: string;
  readonly status: "new" | "already-installed" | "would-conflict" | "fetch-failed" | "parse-failed";
  /** Origin URIs of dep entries (post-rename: dep refs ARE origins). */
  readonly depFqns: readonly string[];
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
 * `rootOrigin` is the install request's input origin. The matching
 * node's fqn (if found in the plan) becomes `rootFqn`; if the input
 * origin is in the conflicts bucket (e.g. relative path → fetch-failed),
 * `rootFqn` falls back to empty string so the dashboard's "n nodes to
 * install" header still renders.
 */
export function planToManifest(plan: CatalogPlan, rootOrigin: string): ResolveManifest {
  const nodes: ResolveManifestNode[] = [];
  for (const planNode of plan.toInstall) {
    nodes.push(planNodeToManifest(planNode, "new"));
  }
  for (const planNode of plan.alreadyInstalled) {
    nodes.push(planNodeToManifest(planNode, "already-installed"));
  }
  for (const conflict of plan.conflicts) {
    nodes.push(conflictToManifest(conflict));
  }

  const rootNode = nodes.find((n) => n.origin === rootOrigin);
  return {
    rootOrigin,
    rootFqn: rootNode?.fqn ?? "",
    nodes,
  };
}

function planNodeToManifest(
  planNode: CatalogPlanNode,
  status: "new" | "already-installed",
): ResolveManifestNode {
  const fqn = planNode.node.fqn;
  if (planNode.kind === "mcp") {
    return {
      kind: "mcp",
      origin: planNode.node.origin,
      fqn,
      status,
      depFqns: [],
      specName: fqn,
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
