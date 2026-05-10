import { useMemo } from "react";
import type { ResolveManifest, ResolveNode } from "../api";

/**
 * Two-phase install preview tree.
 *
 * Read-only display of the {@link ResolveManifest}: per-node FQN,
 * status pill, kind icon, and a "default scope" badge for entries
 * whose frontmatter omitted `scope:` (so the user knows they'll land
 * under `public/<name>`).
 *
 * Scope is NOT editable here — emploke's install flow has no per-call
 * scope override. Forking under a different scope means editing the
 * upstream's frontmatter and installing from your fork; this dialog
 * only shows what you'd get with the current upstream sources.
 *
 * Conflicts (status=`would-conflict`) and failures (`fetch-failed`,
 * `parse-failed`) are surfaced inline so the user can cancel or fix
 * before committing.
 */
export interface ResolveTreeProps {
  manifest: ResolveManifest;
}

export function ResolveTree({ manifest }: ResolveTreeProps) {
  const rootIdx = manifest.nodes.findIndex((n) => n.fqn === manifest.rootFqn);
  const ordered = useMemo(() => {
    if (rootIdx <= 0) return manifest.nodes;
    const root = manifest.nodes[rootIdx];
    if (!root) return manifest.nodes;
    return [root, ...manifest.nodes.filter((_, i) => i !== rootIdx)];
  }, [manifest, rootIdx]);

  const counts = useMemo(() => {
    const c = { new: 0, willSync: 0, alreadyInstalled: 0, problem: 0 };
    for (const n of manifest.nodes) {
      if (n.status === "new") c.new++;
      else if (n.status === "will-sync") c.willSync++;
      else if (n.status === "already-installed") c.alreadyInstalled++;
      else c.problem++;
    }
    return c;
  }, [manifest]);

  return (
    <div className="resolve-tree">
      <div className="resolve-tree__summary">
        <span className="resolve-tree__count">
          {manifest.nodes.length} {manifest.nodes.length === 1 ? "node" : "nodes"}
        </span>
        {counts.new > 0 && (
          <span className="resolve-tree__count resolve-tree__count--new">{counts.new} new</span>
        )}
        {counts.willSync > 0 && (
          <span className="resolve-tree__count resolve-tree__count--sync">
            {counts.willSync} will sync
          </span>
        )}
        {counts.alreadyInstalled > 0 && (
          <span className="resolve-tree__count resolve-tree__count--existing">
            {counts.alreadyInstalled} already installed
          </span>
        )}
        {counts.problem > 0 && (
          <span className="resolve-tree__count resolve-tree__count--problem">
            {counts.problem} {counts.problem === 1 ? "problem" : "problems"}
          </span>
        )}
      </div>

      <ul className="resolve-tree__list">
        {ordered.map((node) => (
          <li key={`${node.kind}:${node.origin}`} className="resolve-tree__item">
            <ResolveTreeRow node={node} isRoot={node.fqn === manifest.rootFqn} />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface RowProps {
  node: ResolveNode;
  isRoot: boolean;
}

function ResolveTreeRow({ node, isRoot }: RowProps) {
  const scopeIsDefault = (node.kind === "skill" || node.kind === "agent") && node.scopeIsDefault;
  const isProblem =
    node.status === "fetch-failed" ||
    node.status === "parse-failed" ||
    node.status === "would-conflict";
  const displayLabel = node.fqn !== "" ? node.fqn : node.origin;
  return (
    <div
      className={[
        "resolve-tree__row",
        isRoot ? "resolve-tree__row--root" : "",
        isProblem ? "resolve-tree__row--problem" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="resolve-tree__kind" data-kind={node.kind} title={node.kind}>
        {kindIcon(node.kind)}
      </span>
      <div className="resolve-tree__main">
        <div className="resolve-tree__line">
          <code className="resolve-tree__fqn" title={node.origin}>
            {displayLabel}
          </code>
          {isRoot && <span className="resolve-tree__root-tag">root</span>}
          {scopeIsDefault && (
            <span
              className="resolve-tree__badge"
              title="Frontmatter omitted `scope:`; using default `public` scope."
            >
              default scope
            </span>
          )}
          <StatusPill status={node.status} />
        </div>
        {node.error && (
          <div className="resolve-tree__error">
            <span className="resolve-tree__error-icon" aria-hidden="true">
              ⚠
            </span>
            <span className="resolve-tree__error-msg" title={node.error.name}>
              {node.error.message}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: ResolveNode["status"] }) {
  return (
    <span className={`resolve-tree__status resolve-tree__status--${status}`}>
      {statusLabel(status)}
    </span>
  );
}

function kindIcon(kind: ResolveNode["kind"]): string {
  switch (kind) {
    case "skill":
      return "🛠";
    case "agent":
      return "🤖";
    case "mcp":
      return "🔌";
  }
}

function statusLabel(status: ResolveNode["status"]): string {
  switch (status) {
    case "new":
      return "new";
    case "will-sync":
      return "will sync";
    case "already-installed":
      return "installed";
    case "would-conflict":
      return "conflict";
    case "fetch-failed":
      return "fetch failed";
    case "parse-failed":
      return "parse failed";
  }
}
