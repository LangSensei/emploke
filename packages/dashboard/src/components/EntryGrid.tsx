import type { BlockedReason, MissingDep } from "@emploke/catalog";
import type { ReactNode } from "react";
import { type EntityKind, KIND_ICON, KIND_TAG } from "../kindMeta";
import { splitFqnForDisplay } from "../utils/fqn";
import { TrashIcon } from "./Icons";

export interface EntryCardItem {
  name: string;
  description: string;
  /** Empty string suppresses the `v…` chip in the footer (used by mcp). */
  version: string;
  status: "ready" | "blocked";
  blockedReason?: BlockedReason;
  missingDeps?: readonly MissingDep[];
  /** Negative suppresses the chip entirely (used by mcp, which has no deps). */
  skillsCount: number;
  mcpsCount: number;
}

interface EntryGridProps {
  /**
   * Entity kind shown in this grid. Drives the small uppercase tag
   * + icon in the card header. EntryGrid is single-kind; the parent
   * page picks which kind list to render at any time.
   */
  kind: EntityKind;
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
 * Phase G2 (TN-B F1-4): the EntryGrid split helper that lived here
 * was one of 5 incompatible reinventions of `splitFqn`. It now lives
 * in `utils/fqn.ts` as `splitFqnForDisplay`, which delegates its
 * boundary semantics to `@emploke/catalog`'s canonical `splitFqn`
 * (indexOf, exactly one `/`). The trailing-slash gluing the old
 * local helper did (`"a/b/"`) is intentionally not preserved — the
 * namespace cell now carries `<scope>/` for normal single-slash
 * FQNs and renders empty when scope is absent, so the existing
 * row-height contract still holds.
 */

function EntryCard({
  kind,
  item,
  onEdit,
  onRemove,
}: {
  kind: EntityKind;
  item: EntryCardItem;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const isBlocked = item.status === "blocked";
  const summary = isBlocked ? blockedSummary(item.blockedReason) : null;
  const { scope, shortName } = splitFqnForDisplay(item.name);
  const showVersion = item.version !== "";
  // mcp callers pass negative counts to opt out of the meta chips
  // (mcps have no deps). agents/skills always show counts including 0.
  const showSkillsCount = item.skillsCount >= 0;
  const showMcpsCount = item.mcpsCount >= 0;
  return (
    // biome-ignore lint/a11y/useSemanticElements: card has nested Remove <button>; nesting buttons is invalid HTML
    <div
      className="card-grid__item"
      data-status={item.status}
      data-entry-name={item.name}
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onEdit();
        }
      }}
      title={`Click to open ${item.name}`}
    >
      <div className="card-grid__header">
        <span className="card-grid__kind">
          <span aria-hidden="true">{KIND_ICON[kind]}</span> {KIND_TAG[kind]}
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
        {/* Namespace row is always rendered (empty span when absent)
         * so cards with and without a `<scope>/` prefix line up to
         * the same total height across the grid. The trailing `/` is
         * appended here in the render path so the consolidated
         * `splitFqnForDisplay` stays slash-free (see utils/fqn.ts). */}
        <span className="card-grid__namespace">{scope === "" ? "" : `${scope}/`}</span>
        <span className="card-grid__short">{shortName}</span>
      </div>
      {/* Description block reserves its 2-line min-height even when
       * empty (mcp cards) so the footer stays at the same y-offset. */}
      <p className="card-grid__desc">{item.description}</p>
      {/* Reason banner always rendered so the row's vertical rhythm
       * is identical between ready and blocked cards. When there's no
       * reason we fall back to a non-breaking space so the line takes
       * its natural baseline height; the warn-color is suppressed by
       * the absence of `--has-reason`. */}
      <p
        className={`card-grid__reason${summary !== null ? " card-grid__reason--filled" : ""}`}
        title={summary !== null ? blockedSummaryTooltip(item.blockedReason) : undefined}
        aria-hidden={summary === null}
      >
        {summary !== null ? (
          <>
            <span aria-hidden="true">⚠</span> Blocked: {summary}
          </>
        ) : (
          "\u00A0"
        )}
      </p>
      <div className="card-grid__footer">
        {showVersion && (
          <>
            <span className="card-grid__meta-item">v{item.version}</span>
            {(showSkillsCount || showMcpsCount) && (
              <span className="card-grid__meta-sep" aria-hidden="true" />
            )}
          </>
        )}
        {showSkillsCount && (
          <span className="card-grid__meta-item">
            {item.skillsCount} skill{item.skillsCount === 1 ? "" : "s"}
          </span>
        )}
        {showSkillsCount && showMcpsCount && (
          <span className="card-grid__meta-sep" aria-hidden="true" />
        )}
        {showMcpsCount && (
          <span className="card-grid__meta-item">
            {item.mcpsCount} mcp{item.mcpsCount === 1 ? "" : "s"}
          </span>
        )}
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
