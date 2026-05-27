import type { ScheduleView } from "../../api";
import { formatAbsolute, formatRelative } from "../../utils/time";

export interface ScheduleListProps {
  schedules: ScheduleView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * Left-column schedule list. One row per schedule with name + cron
 * expression + describe (locale-formatted by the server) + next fire
 * (relative time, with absolute tooltip) + enabled badge + target
 * agent + target runtime.
 *
 * Sorted by `nextFireAt` ascending (server already returns sorted;
 * the page re-applies after client-side filtering for stability).
 * Empty state is rendered by the page when `schedules` is empty —
 * the list never renders a "no rows" message itself. Reuses the
 * existing `.task-list__*` classes so the schedule list lines up
 * visually with the Tasks page without dragging in any new CSS.
 */
export function ScheduleList({ schedules, selectedId, onSelect }: ScheduleListProps) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA listbox pattern requires role on ul
    <ul className="task-list" role="listbox" aria-label="Schedules">
      {schedules.map((s) => {
        const selected = selectedId === s.id;
        const nextLabel = s.nextFireAt ? formatRelative(s.nextFireAt) : "—";
        const nextTitle = s.nextFireAt ? formatAbsolute(s.nextFireAt) : "no upcoming fire";
        return (
          <li
            key={s.id}
            className={`task-list__item${selected ? " task-list__item--selected" : ""}`}
            onClick={() => onSelect(s.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(s.id);
              }
            }}
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA listbox/option pattern
            role="option"
            tabIndex={0}
            aria-selected={selected}
            data-testid={`schedule-row-${s.id}`}
          >
            <div className="task-list__item-head">
              <span
                className={`badge ${s.enabled ? "badge--success" : "badge--muted"} badge--with-dot`}
              >
                <span className="badge__dot" aria-hidden="true" />
                {s.enabled ? "Enabled" : "Paused"}
              </span>
            </div>
            <div
              className="task-list__item-headline task-list__item-headline--clamp"
              title={s.name}
            >
              {s.name}
            </div>
            <div className="task-list__item-meta muted">
              <code title={`Cron: ${s.trigger.expr} (${s.trigger.tz})`}>{s.trigger.expr}</code>
              <span className="task-list__sep">·</span>
              <span title={`Agent: ${s.target.agent}`}>{s.target.agent}</span>
              {s.target.runtime ? (
                <>
                  <span className="task-list__sep">·</span>
                  <span title={`Runtime: ${s.target.runtime}`}>{s.target.runtime}</span>
                </>
              ) : null}
              <span className="task-list__sep">·</span>
              <span className="muted" title={nextTitle}>
                Next {nextLabel}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
