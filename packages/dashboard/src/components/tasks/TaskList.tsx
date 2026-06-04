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
 * Left-column task list, grouped by status. Two groups are rendered —
 * Running and Completed — and the headers stay visible even when empty
 * so the data shape stays predictable while a task moves between
 * buckets (bug-bash iter-1 F6).
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
      { key: "completed", label: "Completed", tasks: completed },
    ];
  }, [tasks]);

  // Empty groups start collapsed (header + count visible only) so the
  // list above the fold stays tight; populated groups start expanded.
  const [collapsed, setCollapsed] = useState<Record<StatusGroup, boolean>>({
    running: false,
    completed: false,
  });
  const toggle = (k: StatusGroup) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  // Page-level coordination: at most one per-row `⋯` menu is open at a
  // time. Opening row B's menu auto-closes A's. The popover itself
  // handles click-outside + Esc inside TaskListItem.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

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
              // biome-ignore lint/a11y/noRedundantRoles: Safari + VoiceOver strips the implicit listitem role from <li> children when the <ul> has `list-style: none` (defined for `.task-list` in styles.css). Without the explicit role here, AT users on macOS/iOS lose list semantics entirely (no "list, N items" announcement, no aria-posinset cues). The explicit role is a no-op in Chrome/Firefox/Edge but a load-bearing fix on Safari.
              <ul role="list" className="task-list" aria-label={`${g.label} tasks`}>
                {g.tasks.map((t, idx, arr) => (
                  <TaskListItem
                    key={t.id}
                    task={t}
                    selected={selectedId === t.id}
                    onSelect={() => onSelect(t.id)}
                    onDelete={() => onDelete(t)}
                    onCancel={() => onCancel(t)}
                    onRerun={() => onRerun(t)}
                    menuOpen={openMenuId === t.id}
                    onMenuOpenChange={(open) => setOpenMenuId(open ? t.id : null)}
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
