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
  onRerun: (task: TaskRecord) => void;
}

interface Group {
  key: StatusGroup;
  label: string;
  tasks: TaskRecord[];
}

/**
 * Left-column task list, grouped by status. Headers are always
 * rendered (Running / Not started / Completed) even when empty so
 * the data shape stays predictable while a task moves between
 * buckets (bug-bash iter-1 F6). The TaskStatus enum has no
 * `queued`/`not_started` row, so the middle group is a deliberately
 * empty placeholder collapsed by default.
 *
 * Each group is collapsible with a count badge. Empty groups
 * auto-collapse so the list above the fold stays compact. Within a
 * group, rows keep the page-supplied ordering (newest-first from
 * `listTasks`).
 */
export function TaskList({
  tasks,
  selectedId,
  onSelect,
  onDelete,
  onCancel,
  onRerun,
}: TaskListProps) {
  const groups = useMemo<Group[]>(() => {
    const running: TaskRecord[] = [];
    const completed: TaskRecord[] = [];
    for (const t of tasks) {
      if (statusGroup(t.status) === "running") running.push(t);
      else completed.push(t);
    }
    return [
      { key: "running", label: "Running", tasks: running },
      { key: "not_started", label: "Not started", tasks: [] },
      { key: "completed", label: "Completed", tasks: completed },
    ];
  }, [tasks]);

  // Empty groups start collapsed (header + count visible only) so the
  // list above the fold stays tight; populated groups start expanded.
  const [collapsed, setCollapsed] = useState<Record<StatusGroup, boolean>>({
    running: false,
    not_started: true,
    completed: false,
  });
  const toggle = (k: StatusGroup) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  return (
    <div className="task-list-groups">
      {groups.map((g) => {
        const isEmpty = g.tasks.length === 0;
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
                    onRerun={() => onRerun(t)}
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
