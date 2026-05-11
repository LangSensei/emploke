import type { BlockedReason, MissingDep } from "@emploke/catalog";
import type { ReactNode } from "react";
import { TrashIcon } from "./Icons";

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
  items: EntryCardItem[];
  emptyTitle: string;
  emptyHint?: ReactNode;
  onEdit: (name: string) => void;
  onRemove: (name: string) => void;
}

export function EntryGrid({ items, emptyTitle, emptyHint, onEdit, onRemove }: EntryGridProps) {
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

function EntryCard({
  item,
  onEdit,
  onRemove,
}: {
  item: EntryCardItem;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const isBlocked = item.status === "blocked";
  const summary = isBlocked ? blockedSummary(item.blockedReason) : null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: card has nested Remove <button>; nesting buttons is invalid HTML
    <div
      className={`card-grid__item${isBlocked ? " card-grid__item--disabled" : ""}`}
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
      {/*
        Header strip: the badge floats on its own row above the name.
        We used to put both on one row (`.card-grid__top` with flex)
        but long fqns and longer reason badges (e.g. "blocked deps")
        kept clipping the name into a second visual line. Lifting the
        badge to its own right-aligned row lets the name take the full
        card width and keeps the badge column predictable.
      */}
      <div className="card-grid__badge-row">
        {item.status === "ready" ? (
          <span className="badge badge--ready">✓ ready</span>
        ) : (
          <span className="badge badge--disabled" title={blockedSummaryTooltip(item.blockedReason)}>
            ⛔ blocked
          </span>
        )}
      </div>
      <div className="card-grid__name" title={item.name}>
        {item.name}
      </div>
      <p className="card-grid__desc">{item.description}</p>
      {summary !== null && (
        <p
          className="card-grid__desc card-grid__desc--needs"
          title={blockedSummaryTooltip(item.blockedReason)}
        >
          <span className="card-grid__needs-icon" aria-hidden="true">
            ⛔
          </span>{" "}
          {summary}
        </p>
      )}
      <div className="card-grid__footer">
        <div className="card-grid__meta">
          <span className="card-grid__version">v{item.version}</span>
          {(item.skillsCount > 0 || item.mcpsCount > 0) && (
            <>
              <span className="card-grid__sep">·</span>
              {item.skillsCount > 0 && (
                <span>
                  {item.skillsCount} skill{item.skillsCount === 1 ? "" : "s"}
                </span>
              )}
              {item.skillsCount > 0 && item.mcpsCount > 0 && (
                <span className="card-grid__sep">·</span>
              )}
              {item.mcpsCount > 0 && (
                <span>
                  {item.mcpsCount} MCP{item.mcpsCount === 1 ? "" : "s"}
                </span>
              )}
            </>
          )}
        </div>
        <button
          type="button"
          className="card-grid__action"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove ${item.name}`}
          title={`Remove ${item.name}`}
        >
          <TrashIcon />
          <span>Remove</span>
        </button>
      </div>
    </div>
  );
}
