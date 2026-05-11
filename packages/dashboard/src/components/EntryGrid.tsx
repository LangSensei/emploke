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

function NeedsLine({ deps }: { deps: readonly MissingDep[] }) {
  const skills = deps.filter((d) => d.kind === "skill");
  const mcps = deps.filter((d) => d.kind === "mcp");
  const fullList = deps.map((d) => `${d.kind} ${d.name}`).join(", ");
  const parts: string[] = [];
  if (skills.length > 0) parts.push(`skill: ${skills.map((d) => d.name).join(", ")}`);
  if (mcps.length > 0) parts.push(`mcp: ${mcps.map((d) => d.name).join(", ")}`);
  return (
    <p className="card-grid__desc card-grid__desc--needs" title={`Missing: ${fullList}`}>
      <span className="card-grid__needs-icon" aria-hidden="true">
        ⛔
      </span>{" "}
      Needs {parts.join(" · ")}
    </p>
  );
}

/**
 * Project a {@link BlockedReason} into a single user-facing badge label.
 * Self causes are listed first, then dep-cascade causes — the order
 * matches the dashboard's CTA priority (fix self before fixing deps).
 */
function blockedBadgeLabel(reason: BlockedReason | undefined): string {
  if (reason === undefined) return "blocked";
  if (reason.disabledByUser) return "disabled";
  if (reason.needsPrereqsAck) return "needs ack";
  if (reason.orphaned) return "orphaned";
  if (reason.missingDeps && reason.missingDeps.length > 0) return "missing deps";
  if (reason.blockedDeps && reason.blockedDeps.length > 0) return "blocked deps";
  return "blocked";
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
      <div className="card-grid__top">
        <span className="card-grid__name" title={item.name}>
          {item.name}
        </span>
        {item.status === "ready" ? (
          <span className="badge badge--ready">✓ ready</span>
        ) : (
          <span className="badge badge--disabled">⛔ {blockedBadgeLabel(item.blockedReason)}</span>
        )}
      </div>
      {isBlocked && item.missingDeps && item.missingDeps.length > 0 ? (
        <NeedsLine deps={item.missingDeps} />
      ) : (
        <p className="card-grid__desc">{item.description}</p>
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
