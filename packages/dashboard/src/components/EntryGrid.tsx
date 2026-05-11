import type { BlockedReason, MissingDep } from "@emploke/catalog";
import type { ReactNode } from "react";
import { TrashIcon } from "./Icons";

export type EntryKind = "agent" | "skill" | "mcp";

export interface EntryCardItem {
  name: string;
  description: string;
  version: string;
  status: "ready" | "blocked";
  blockedReason?: BlockedReason;
  missingDeps?: readonly MissingDep[];
  skillsCount: number;
  mcpsCount: number;
}

interface EntryGridProps {
  /**
   * Entity kind shown in this grid. Drives the small uppercase label
   * + icon in the card header. EntryGrid is single-kind by design;
   * mcps go through the dedicated McpGrid.
   */
  kind: Exclude<EntryKind, "mcp">;
  items: EntryCardItem[];
  emptyTitle: string;
  emptyHint?: ReactNode;
  onEdit: (name: string) => void;
  onRemove: (name: string) => void;
}

export function EntryGrid({
  kind,
  items,
  emptyTitle,
  emptyHint,
  onEdit,
  onRemove,
}: EntryGridProps) {
  if (items.length === 0) {
    return (
      <div className="empty">
        <div className="empty__icon">∅</div>
        <h3 className="empty__title">{emptyTitle}</h3>
        {emptyHint && <p className="empty__hint">{emptyHint}</p>}
      </div>
    );
  }
  return (
    <div className="card-grid">
      {items.map((item) => (
        <EntryCard
          key={item.name}
          kind={kind}
          item={item}
          onEdit={() => onEdit(item.name)}
          onRemove={() => onRemove(item.name)}
        />
      ))}
    </div>
  );
}

/**
 * Project a {@link BlockedReason} into a compact multi-reason summary
 * like `"disabled · missing 2 deps · 1 dep blocked"`. Each reason is
 * abbreviated to a few words; specifics live in DetailDialog.
 *
 * Reasons can co-occur (a user-disabled agent can also have missing
 * deps), so we deliberately list every populated reason instead of
 * picking one — picking one would mislead the user (clicking Enable
 * wouldn't make a missing-dep entry usable).
 *
 * Returns `null` when the reason is undefined or empty so callers can
 * fall back to the description.
 */
function blockedSummary(reason: BlockedReason | undefined): string | null {
  if (reason === undefined) return null;
  const parts: string[] = [];
  if (reason.disabledByUser) parts.push("disabled");
  if (reason.needsPrereqsAck) parts.push("needs ack");
  if (reason.orphaned) parts.push("orphaned");
  if (reason.missingDeps && reason.missingDeps.length > 0) {
    const n = reason.missingDeps.length;
    parts.push(`missing ${n} dep${n === 1 ? "" : "s"}`);
  }
  if (reason.blockedDeps && reason.blockedDeps.length > 0) {
    const n = reason.blockedDeps.length;
    parts.push(`${n} dep${n === 1 ? "" : "s"} blocked`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Tooltip-friendly long form of {@link blockedSummary}. */
function blockedSummaryTooltip(reason: BlockedReason | undefined): string {
  if (reason === undefined) return "";
  const lines: string[] = [];
  if (reason.disabledByUser) lines.push("Disabled by user — re-enable in DetailDialog");
  if (reason.needsPrereqsAck) lines.push("Prereqs not acknowledged");
  if (reason.orphaned) lines.push("Orphaned (no reverse-deps)");
  if (reason.missingDeps && reason.missingDeps.length > 0) {
    lines.push(`Missing deps: ${reason.missingDeps.map((d) => `${d.kind} ${d.name}`).join(", ")}`);
  }
  if (reason.blockedDeps && reason.blockedDeps.length > 0) {
    lines.push(`Blocked deps: ${reason.blockedDeps.map((d) => d.fqn).join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Split `<scope>/<short>` into namespace prefix + bold short name.
 * Names without `/` (legacy / unscoped) render entirely as short.
 */
function splitFqn(fqn: string): { namespace: string; short: string } {
  const slash = fqn.lastIndexOf("/");
  if (slash < 0) return { namespace: "", short: fqn };
  return { namespace: fqn.slice(0, slash + 1), short: fqn.slice(slash + 1) };
}

const KIND_ICON: Record<EntryKind, string> = {
  agent: "🤖",
  skill: "🛠",
  mcp: "🔌",
};

const KIND_LABEL: Record<EntryKind, string> = {
  agent: "AGENT",
  skill: "SKILL",
  mcp: "MCP",
};

function EntryCard({
  kind,
  item,
  onEdit,
  onRemove,
}: {
  kind: EntryKind;
  item: EntryCardItem;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const isBlocked = item.status === "blocked";
  const summary = isBlocked ? blockedSummary(item.blockedReason) : null;
  const { namespace, short } = splitFqn(item.name);
  // Card chrome: status drives a left-edge color stripe (via
  // data-status attr → CSS) instead of a corner badge. The badge that
  // used to fight the title for horizontal space is now a small dot
  // pill in the footer; the stripe is what the eye picks up while
  // scanning the grid.
  return (
    // biome-ignore lint/a11y/useSemanticElements: card has nested Remove <button>; nesting buttons is invalid HTML
    <div
      className="card-grid__item"
      data-status={item.status}
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onEdit();
        }
      }}
      title={`Click to edit ${item.name}`}
    >
      <div className="card-grid__header">
        <span className="card-grid__kind">
          <span aria-hidden="true">{KIND_ICON[kind]}</span> {KIND_LABEL[kind]}
        </span>
        <button
          type="button"
          className="card-grid__action card-grid__action--icon"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove ${item.name}`}
          title={`Remove ${item.name}`}
        >
          <TrashIcon />
        </button>
      </div>
      <div className="card-grid__title" title={item.name}>
        {namespace !== "" && <span className="card-grid__namespace">{namespace}</span>}
        <span className="card-grid__short">{short}</span>
      </div>
      <p className="card-grid__desc">{item.description}</p>
      {summary !== null && (
        <p className="card-grid__reason" title={blockedSummaryTooltip(item.blockedReason)}>
          <span aria-hidden="true">⚠</span> Blocked: {summary}
        </p>
      )}
      <div className="card-grid__footer">
        <span className="card-grid__meta-item">v{item.version}</span>
        <span className="card-grid__meta-sep" aria-hidden="true" />
        <span className="card-grid__meta-item">
          {item.skillsCount} skill{item.skillsCount === 1 ? "" : "s"}
        </span>
        <span className="card-grid__meta-sep" aria-hidden="true" />
        <span className="card-grid__meta-item">
          {item.mcpsCount} mcp{item.mcpsCount === 1 ? "" : "s"}
        </span>
        <span className="card-grid__meta-spacer" />
        <span
          className={`card-grid__status card-grid__status--${item.status}`}
          title={isBlocked ? blockedSummaryTooltip(item.blockedReason) : "All checks passed"}
        >
          <span className="card-grid__status-dot" aria-hidden="true" />
          {item.status === "ready" ? "Ready" : "Blocked"}
        </span>
      </div>
    </div>
  );
}
