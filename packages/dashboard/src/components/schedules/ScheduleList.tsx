import type { ScheduleView } from "../../api";
import { ScheduleListItem } from "./ScheduleListItem";

export interface ScheduleListProps {
  schedules: ScheduleView[];
  selectedId: string | null;
  onSelect: (id: string) => void;

  /** Page-supplied action callbacks; the list forwards them per-row. */
  onEdit: (target: ScheduleView) => void;
  onToggleEnabled: (target: ScheduleView) => Promise<void> | void;
  onRunNow: (target: ScheduleView) => Promise<void> | void;
  onDelete: (target: ScheduleView) => void;

  /**
   * Page-supplied row-scoped busy state. Keyed by `scheduleId` so an
   * in-flight mutation on row A does not lock row B's menu. Each row
   * receives its own slice (`busyByScheduleId[s.id] ?? null`).
   */
  busyByScheduleId: Record<string, "toggle" | "run">;

  /** Page-supplied single-open coordination. */
  openMenuId: string | null;
  onMenuOpenChange: (id: string | null) => void;
}

/**
 * Left-column schedule list. One row per schedule with name + cron
 * expression + agent + runtime + next-fire (relative time, with
 * absolute tooltip) + enabled badge + the per-row `⋯` action menu.
 *
 * Sorted by `nextFireAt` ascending (server already returns sorted;
 * the page re-applies after client-side filtering for stability).
 * Empty state is rendered by the page when `schedules` is empty —
 * the list never renders a "no rows" message itself. Reuses the
 * existing `.task-list__*` classes so the schedule list lines up
 * visually with the Tasks page without dragging in any new CSS.
 *
 * Row markup + ⋯ menu live in `ScheduleListItem`. This component is
 * a thin labelled `<ul>` wrapper that delegates rendering and forwards
 * the page-level coordination props per-row. The `<ul>` carries an
 * explicit `role="list"` (workaround for Safari + VoiceOver stripping
 * the implicit listitem role when `list-style: none` is set; see
 * inline comment on the JSX) but does NOT use a widget role like
 * `listbox`: each row's interactive affordance is a real `<button>`
 * that the screen reader announces directly, rather than an
 * ARIA-faked listbox shape whose keyboard contract we don't actually
 * implement.
 */
export function ScheduleList({
  schedules,
  selectedId,
  onSelect,
  onEdit,
  onToggleEnabled,
  onRunNow,
  onDelete,
  busyByScheduleId,
  openMenuId,
  onMenuOpenChange,
}: ScheduleListProps) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: Safari + VoiceOver strips the implicit listitem role from <li> children when the <ul> has `list-style: none` (defined for `.task-list` in styles.css). Without the explicit role here, AT users on macOS/iOS lose list semantics entirely (no "list, N items" announcement, no aria-posinset cues). The explicit role is a no-op in Chrome/Firefox/Edge but a load-bearing fix on Safari.
    <ul role="list" className="task-list" aria-label="Schedules">
      {schedules.map((s, idx, arr) => (
        <ScheduleListItem
          key={s.id}
          schedule={s}
          selected={selectedId === s.id}
          onSelect={() => onSelect(s.id)}
          onEdit={() => onEdit(s)}
          onToggleEnabled={() => onToggleEnabled(s)}
          onRunNow={() => onRunNow(s)}
          onDelete={() => onDelete(s)}
          busyAction={busyByScheduleId[s.id] ?? null}
          menuOpen={openMenuId === s.id}
          onMenuOpenChange={(open) => onMenuOpenChange(open ? s.id : null)}
          posinset={idx + 1}
          setsize={arr.length}
        />
      ))}
    </ul>
  );
}
