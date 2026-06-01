import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClickOutside } from "../../hooks/useClickOutside";
import type { CatalogTab } from "./CATALOG_VERBS";

export type StatusFilter = "all" | "ready" | "blocked" | "orphaned";

interface FilterMenuProps {
  /** Which catalog tab is active — drives which options are valid. */
  tab: CatalogTab;
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
  /** Surfaced as a count next to the Orphaned option. */
  orphanCount: number;
}

interface FilterOption {
  readonly value: StatusFilter;
  readonly label: string;
  /** Optional count to render as a small chip after the label. */
  readonly count?: number;
}

const FILTER_LABEL: Record<StatusFilter, string> = {
  all: "All",
  ready: "Ready",
  blocked: "Blocked",
  orphaned: "Orphaned",
};

/**
 * Per-tab filter menu, opened from a single toolbar button so the
 * top strip stays at one row of chrome regardless of how many filter
 * dimensions we add later.
 *
 * Implementation: a controlled popover (state-driven open/close).
 * We previously used a native `<details>`/`<summary>` and claimed it
 * gave close-on-outside-click + Esc for free — that was wrong.
 * Browsers don't run a global handler on `<details>` and Esc only
 * closes when focus is already inside the panel. The current pattern:
 *   - `open` state on this component drives `aria-expanded` on the
 *     trigger and conditional render of the panel.
 *   - `useClickOutside` listens on `document` `pointerdown` and closes
 *     when the event target is outside both the trigger and the panel.
 *   - A `keydown` listener on `document` closes on Escape.
 *   - The panel is `position: absolute` (parent `.filter-menu` is
 *     `position: relative`) and lives above the grid below via a
 *     high z-index, so opening the menu does not change toolbar
 *     height.
 *
 * Per-tab option set:
 *   - agents: All / Ready / Blocked         (agents can never be orphaned)
 *   - skills: All / Ready / Blocked / Orphaned
 *   - mcps:   All / Orphaned                (mcps have no ready/blocked semantics)
 *
 * If the active tab doesn't support the current filter (e.g. user was
 * on Skills with "Blocked" and switches to Mcps), the parent caller
 * is responsible for resetting the value on tab change.
 */
export function FilterMenu({ tab, value, onChange, orphanCount }: FilterMenuProps) {
  const options: FilterOption[] = [{ value: "all", label: FILTER_LABEL.all }];
  if (tab !== "mcps") {
    options.push(
      { value: "ready", label: FILTER_LABEL.ready },
      { value: "blocked", label: FILTER_LABEL.blocked },
    );
  }
  if (tab !== "agents") {
    options.push({
      value: "orphaned",
      label: FILTER_LABEL.orphaned,
      ...(orphanCount > 0 ? { count: orphanCount } : {}),
    });
  }

  const activeLabel = FILTER_LABEL[value];
  const isFiltered = value !== "all";

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);
  // Stable ref array so useClickOutside's effect deps don't churn each render.
  const outsideRefs = useMemo(() => [triggerRef, panelRef] as const, []);
  useClickOutside(outsideRefs, close, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="filter-menu">
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn--ghost filter-menu__trigger${isFiltered ? " filter-menu__trigger--active" : ""}`}
        title={isFiltered ? `Showing ${activeLabel} only` : "Filter by status"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="filter-menu__icon" aria-hidden="true">
          ⚙
        </span>
        Filters
        {isFiltered && (
          <>
            <span className="filter-menu__sep" aria-hidden="true">
              ·
            </span>
            <span className="filter-menu__current">{activeLabel}</span>
          </>
        )}
      </button>
      {open && (
        <div ref={panelRef} className="filter-menu__panel" role="menu">
          <div className="filter-menu__group-label">Status</div>
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="menuitemradio"
              aria-checked={value === opt.value}
              className={`filter-menu__option${value === opt.value ? " filter-menu__option--active" : ""}`}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            >
              <span className="filter-menu__radio" aria-hidden="true">
                {value === opt.value ? "●" : "○"}
              </span>
              <span className="filter-menu__option-label">{opt.label}</span>
              {opt.count !== undefined && (
                <span className="filter-menu__option-count">{opt.count}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
