import { useMemo, useState } from "react";
import type { TaskRecord } from "../../api";
import { type StatusGroup, statusGroup } from "./shared";
import { TaskListItem } from "./TaskListItem";

export interface TaskListProps {
  tasks: TaskRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (task: TaskRecord) => void;
  onCancel: (task: TaskRecord) => Promise<void> | void;
}

interface Group {
  key: StatusGroup;
  label: string;
  tasks: TaskRecord[];
}

/**
 * Left-column task list, grouped by status (Running vs Completed —
 * the TaskStatus enum has no `queued`/`not_started`, so the mockup's
 * "Not started" group is intentionally omitted per the mission brief).
 *
 * Each group is collapsible with a count badge. Within a group, rows
 * keep the page-supplied ordering (newest-first from `listTasks`).
 */
export function TaskList({ tasks, selectedId, onSelect, onDelete, onCancel }: TaskListProps) {
  const groups = useMemo<Group[]>(() => {
    const running: TaskRecord[] = [];
    const completed: TaskRecord[] = [];
    for (const t of tasks) {
      if (statusGroup(t.status) === "running") running.push(t);
      else completed.push(t);
    }
    return [
      { key: "running", label: "Running", tasks: running },
      { key: "completed", label: "Completed", tasks: completed },
    ];
  }, [tasks]);

  // Default both groups open; toggle via the section header.
  const [collapsed, setCollapsed] = useState<Record<StatusGroup, boolean>>({
    running: false,
    completed: false,
  });
  const toggle = (k: StatusGroup) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  return (
    <div className="task-list-groups">
      {groups.map((g) => {
        if (g.tasks.length === 0) return null;
        const isCollapsed = collapsed[g.key];
        return (
          <section key={g.key} className="task-list-group">
            <button
              type="button"
              className="task-list-group__header"
              aria-expanded={!isCollapsed}
              onClick={() => toggle(g.key)}
            >
              <span className={`task-list-group__caret${isCollapsed ? " is-collapsed" : ""}`}>
                {isCollapsed ? "▸" : "▾"}
              </span>
              <span className="task-list-group__label">{g.label}</span>
              <span className="task-list-group__count">{g.tasks.length}</span>
            </button>
            {!isCollapsed && (
              <ul
                className="task-list"
                // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA listbox pattern requires role on ul
                role="listbox"
                aria-label={`${g.label} tasks`}
              >
                {g.tasks.map((t) => (
                  <TaskListItem
                    key={t.id}
                    task={t}
                    selected={selectedId === t.id}
                    onSelect={() => onSelect(t.id)}
                    onDelete={() => onDelete(t)}
                    onCancel={() => onCancel(t)}
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
