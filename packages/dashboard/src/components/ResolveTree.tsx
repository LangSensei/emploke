import { type ChangeEvent, useMemo } from "react";
import type { ResolveManifest, ResolveNode } from "../api";

/**
 * Two-phase install preview tree.
 *
 * Renders each node from the {@link ResolveManifest} with:
 *  - kind icon + FQN
 *  - status pill (`new` / `already-installed` / `would-conflict` /
 *    `fetch-failed` / `parse-failed`)
 *  - scope source badge (L1 inline / L2 catalog.json / L3 default)
 *  - inline scope editor (skill/agent only; MCP nodes show FQN read-only)
 *  - collapsible dep edges so the user can scan the tree
 *
 * Edits feed an opaque `scopeHints` map (FQN as resolved → user-chosen
 * scope) the parent dialog passes to the install endpoint.
 *
 * `onScopeChange(fqn, scope)` — `scope === ""` means "revert to default"
 * (parent removes the entry from the hints map).
 */
export interface ResolveTreeProps {
  manifest: ResolveManifest;
  /** FQN → scope override; sparse. */
  scopeHints: Record<string, string>;
  onScopeChange: (fqn: string, scope: string) => void;
  disabled?: boolean;
}

export function ResolveTree({ manifest, scopeHints, onScopeChange, disabled }: ResolveTreeProps) {
  // Order: root first, then everything else as the manifest produced them
  // (BFS in catalog/src/resolve.ts).
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
        is editable on skill / agent rows; MCPs are pinned to their spec name.
      </p>
      <ul className="resolve-tree__list">
        {ordered.map((node) => (
          <li key={node.fqn} className="resolve-tree__item">
            <ResolveTreeRow
              node={node}
              isRoot={node.fqn === manifest.rootFqn}
              currentScope={scopeHints[node.fqn]}
              onScopeChange={onScopeChange}
              disabled={disabled}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface RowProps {
  node: ResolveNode;
  isRoot: boolean;
  /** Current scope hint for this node (undefined = use default). */
  currentScope: string | undefined;
  onScopeChange: (fqn: string, scope: string) => void;
  disabled?: boolean;
}

function ResolveTreeRow({ node, isRoot, currentScope, onScopeChange, disabled }: RowProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onScopeChange(node.fqn, e.target.value);
  };
  const editable = node.editable && node.kind !== "mcp" && !disabled;
  const defaultScope = node.kind === "skill" || node.kind === "agent" ? node.defaultScope : "";
  return (
    <div className={`resolve-tree__row ${isRoot ? "resolve-tree__row--root" : ""}`}>
      <span className="resolve-tree__kind" data-kind={node.kind}>
        {kindIcon(node.kind)}
      </span>
      <div className="resolve-tree__meta">
        <code className="resolve-tree__fqn">{node.fqn}</code>
        <StatusPill status={node.status} />
        {(node.kind === "skill" || node.kind === "agent") && (
          <ScopeBadge source={node.scopeSource} pattern={node.matchedPattern} />
        )}
      </div>
      {editable ? (
        <label className="resolve-tree__scope-edit">
          <span className="resolve-tree__scope-label">scope</span>
          <input
            type="text"
            value={currentScope ?? defaultScope}
            onChange={handleChange}
            className="resolve-tree__scope-input"
            placeholder={defaultScope}
            disabled={disabled}
          />
        </label>
      ) : node.kind === "mcp" ? (
        <span className="resolve-tree__scope-frozen">spec FQN (locked)</span>
      ) : (
        <span className="resolve-tree__scope-frozen">{defaultScope}</span>
      )}
      {node.error && (
        <div className="resolve-tree__error" title={node.error.name}>
          ⚠ {node.error.message}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: ResolveNode["status"] }) {
  const className = `pill pill--status-${status}`;
  return <span className={className}>{statusLabel(status)}</span>;
}

function ScopeBadge({ source, pattern }: { source: "L1" | "L2" | "L3"; pattern?: string }) {
  const title = pattern ? `matched pattern: ${pattern}` : sourceTitle(source);
  return (
    <span className={`pill pill--scope-${source.toLowerCase()}`} title={title}>
      {sourceLabel(source)}
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

function sourceLabel(source: "L1" | "L2" | "L3"): string {
  switch (source) {
    case "L1":
      return "inline";
    case "L2":
      return "mapped";
    case "L3":
      return "default";
  }
}

function sourceTitle(source: "L1" | "L2" | "L3"): string {
  switch (source) {
    case "L1":
      return "Scope is set inline in the entry's frontmatter (`scope:` field)";
    case "L2":
      return "Scope resolved via your catalog.json scopeMappings";
    case "L3":
      return "Scope derived from origin (publisher default)";
  }
}
