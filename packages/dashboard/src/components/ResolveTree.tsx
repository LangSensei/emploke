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

  return (
    <div className="resolve-tree">
      <p className="form-hint">
        {manifest.nodes.length} {manifest.nodes.length === 1 ? "node" : "nodes"} to install. Scope
        comes from each entry's frontmatter (or <code>public</code> when omitted). To install under
        a different scope, fork the upstream and edit its <code>scope:</code> field.
      </p>
      <ul className="resolve-tree__list">
        {ordered.map((node) => (
          <li key={node.fqn} className="resolve-tree__item">
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
  return (
    <div className={`resolve-tree__row ${isRoot ? "resolve-tree__row--root" : ""}`}>
      <span className="resolve-tree__kind" data-kind={node.kind}>
        {kindIcon(node.kind)}
      </span>
      <div className="resolve-tree__meta">
        <code className="resolve-tree__fqn">{node.fqn}</code>
        <StatusPill status={node.status} />
        {scopeIsDefault && (
          <span
            className="pill pill--scope-default"
            title="The entry's frontmatter omitted `scope:`; emploke is using the default `public` scope."
          >
            default scope
          </span>
        )}
      </div>
      {node.error && (
        <div className="resolve-tree__error" title={node.error.name}>
          ⚠ {node.error.message}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: ResolveNode["status"] }) {
  return <span className={`pill pill--status-${status}`}>{statusLabel(status)}</span>;
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
    case "already-installed":
      return "already installed";
    case "would-conflict":
      return "conflict";
    case "fetch-failed":
      return "fetch failed";
    case "parse-failed":
      return "parse failed";
  }
}
