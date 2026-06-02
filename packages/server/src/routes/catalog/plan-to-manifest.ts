import type { OrphanManifestEntry, ResolveManifest, ResolveManifestNode } from "@emploke/api";
import type { CatalogConflict, CatalogPlan, CatalogPlanNode } from "@emploke/catalog";

// Re-export wire types for in-pkg consumers that already pulled them from
// this module via `import type { ResolveManifest } from "./plan-to-manifest.js"`.
// The canonical source is now `@emploke/api`; this re-export is
// pure-type, no runtime emit.
export type { OrphanManifestEntry, ResolveManifest, ResolveManifestNode };

/**
 * Internal alias for the discriminated node-status field. Mirrors the
 * `BaseNode["status"]` union declared in `@emploke/api`; kept
 * private to this file to avoid leaking the implementation detail to
 * server-internal consumers.
 */
type NodeStatus = ResolveManifestNode["status"];

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

function planNodeToManifest(planNode: CatalogPlanNode, status: NodeStatus): ResolveManifestNode {
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
