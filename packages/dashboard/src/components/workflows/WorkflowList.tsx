import { useMemo, useState } from "react";
import type { WorkflowHeaderWire } from "../../api";
import { type StatusGroup, statusGroup } from "./shared";
import { WorkflowListItem } from "./WorkflowListItem";

export interface WorkflowListProps {
  workflows: readonly WorkflowHeaderWire[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Page-supplied action callback. The list forwards it per-row so any
   *  row's `⋯` menu can cancel any workflow without selecting it first. */
  onCancel: (target: WorkflowHeaderWire) => void;
  /** Page-supplied single-open coordination. */
  openMenuId: string | null;
  onMenuOpenChange: (id: string | null) => void;
}

interface Group {
  key: StatusGroup;
  label: string;
  workflows: readonly WorkflowHeaderWire[];
}

/**
 * Left-column workflow list, grouped by status (Running / Completed).
 * Same shape as `components/tasks/TaskList`: collapsible sections with
 * a count badge, empty groups auto-collapse, and row content is
 * delegated to {@link WorkflowListItem}. Reuses the `task-list*` CSS
 * classes verbatim so both pages stay visually identical.
 */
export function WorkflowList({
  workflows,
  selectedId,
  onSelect,
  onCancel,
  openMenuId,
  onMenuOpenChange,
}: WorkflowListProps) {
  const groups = useMemo<Group[]>(() => {
    const running: WorkflowHeaderWire[] = [];
    const completed: WorkflowHeaderWire[] = [];
    for (const w of workflows) {
      if (statusGroup(w.status) === "running") running.push(w);
      else completed.push(w);
    }
    return [
      { key: "running", label: "Running", workflows: running },
      { key: "completed", label: "Completed", workflows: completed },
    ];
  }, [workflows]);

  const [collapsed, setCollapsed] = useState<Record<StatusGroup, boolean>>({
    running: false,
    completed: false,
  });
  const toggle = (k: StatusGroup) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  return (
    <div className="task-list-groups">
      {groups.map((g) => {
        const isEmpty = g.workflows.length === 0;
        const isCollapsed = collapsed[g.key] || isEmpty;
        return (
          <section
            key={g.key}
            className={`task-list-group${isEmpty ? " task-list-group--empty" : ""}`}
          >
            <button
              type="button"
              className="task-list-group__header"
              aria-expanded={!isCollapsed}
              onClick={() => !isEmpty && toggle(g.key)}
              disabled={isEmpty}
            >
              <span className={`task-list-group__caret${isCollapsed ? " is-collapsed" : ""}`}>
                {isCollapsed ? "▸" : "▾"}
              </span>
              <span className="task-list-group__label">{g.label}</span>
              <span className="task-list-group__count">{g.workflows.length}</span>
            </button>
            {!isCollapsed && (
              // biome-ignore lint/a11y/noRedundantRoles: Safari + VoiceOver strip the implicit listitem role from <li> children when the <ul> has `list-style: none`. See components/schedules/ScheduleList.tsx for the parallel justification.
              <ul role="list" className="task-list" aria-label={`${g.label} workflows`}>
                {g.workflows.map((w, idx, arr) => (
                  <WorkflowListItem
                    key={w.id}
                    workflow={w}
                    selected={selectedId === w.id}
                    onSelect={() => onSelect(w.id)}
                    onCancel={onCancel}
                    menuOpen={openMenuId === w.id}
                    onMenuOpenChange={(open) => onMenuOpenChange(open ? w.id : null)}
                    posinset={idx + 1}
                    setsize={arr.length}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
