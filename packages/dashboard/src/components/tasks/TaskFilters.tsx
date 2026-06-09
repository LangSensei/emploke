import type { AgentEntry } from "@emploke/contracts";
import { SearchIcon } from "../common/SearchIcon";
import { ALL_AGENTS, ALL_RUNTIMES, TIME_PRESETS, type TimePreset } from "./shared";

export interface TaskFiltersProps {
  idQuery: string;
  onIdQueryChange: (v: string) => void;
  agentFilter: string;
  onAgentFilterChange: (v: string) => void;
  runtimeFilter: string;
  onRuntimeFilterChange: (v: string) => void;
  timeFilter: TimePreset;
  onTimeFilterChange: (v: TimePreset) => void;
  agents: AgentEntry[];
  filterAgentNames: string[];
  runtimes: string[];
  /**
   * When true, the agent `<select>` is omitted from the rendered row.
   * The parent should still pass `agentFilter` (e.g. fixed to the page's
   * agent) so downstream filtering logic in `useTasks` / `TasksPage`
   * keeps working unchanged. Used by the per-agent Tasks tab where the
   * scope is already implicit in the URL.
   */
  hideAgentFilter?: boolean;
}

/**
 * Filter strip rendered above the task list in the master-detail view.
 *
 * Phase A: single horizontal row (search grows, dropdowns + time pills
 * trail right). Wraps naturally at narrower widths. The Origin pills
 * were removed — the Tasks page is standalone-only; workflow-origin
 * tasks surface on a separate (future) page.
 *
 * PR #189 polish v6 dropped the Running / Completed status pill: the
 * list itself (`TaskList.tsx`) already groups visually by status, so
 * the pill only ever collapsed one bucket — low value, and Sessions
 * has no equivalent. Filtering surface now matches: search, agent,
 * runtime, and time preset. A stale `?status=` URL slot is ignored.
 */
export function TaskFilters(props: TaskFiltersProps) {
  const {
    idQuery,
    onIdQueryChange,
    agentFilter,
    onAgentFilterChange,
    runtimeFilter,
    onRuntimeFilterChange,
    timeFilter,
    onTimeFilterChange,
    filterAgentNames,
    runtimes,
    hideAgentFilter,
  } = props;
  return (
    <div className="task-filters">
      <div className="task-filters__row task-filters__row--compact">
        <div className="task-filters__search-wrap">
          <SearchIcon />
          <input
            id="task-id-filter"
            type="search"
            value={idQuery}
            onChange={(e) => onIdQueryChange(e.target.value)}
            placeholder="Search task id…"
            className="input task-filters__search"
            aria-label="Search by task id"
          />
        </div>
        {!hideAgentFilter && (
          <select
            id="task-agent-filter"
            aria-label="Filter by agent"
            value={agentFilter}
            onChange={(e) => onAgentFilterChange(e.target.value)}
            className="select task-filters__select"
          >
            <option value={ALL_AGENTS}>All agents</option>
            {filterAgentNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        <select
          id="task-runtime-filter"
          aria-label="Filter by runtime"
          value={runtimeFilter}
          onChange={(e) => onRuntimeFilterChange(e.target.value)}
          className="select task-filters__select"
          disabled={runtimes.length === 0}
        >
          <option value={ALL_RUNTIMES}>All runtimes</option>
          {runtimes.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <div className="pills task-filters__pills">
          {TIME_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              className={`pills__btn${timeFilter === p.value ? " pills__btn--active" : ""}`}
              onClick={() => onTimeFilterChange(p.value)}
              aria-pressed={timeFilter === p.value}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
