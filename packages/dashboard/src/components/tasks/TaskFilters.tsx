import type { AgentEntry } from "@emploke/catalog";
import { ALL_AGENTS, ALL_RUNTIMES, TIME_PRESETS, type TimePreset } from "./shared";

/**
 * Status-group filter for the master Tasks list (Phase 1.5 §4.6 /
 * Block G). `all` shows both Running and Completed groups (current
 * behaviour); the other two narrow to one bucket each by hiding the
 * other group's rows before the list groups them.
 */
export type StatusFilter = "all" | "running" | "completed";

const STATUS_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
];

export interface TaskFiltersProps {
  idQuery: string;
  onIdQueryChange: (v: string) => void;
  agentFilter: string;
  onAgentFilterChange: (v: string) => void;
  runtimeFilter: string;
  onRuntimeFilterChange: (v: string) => void;
  timeFilter: TimePreset;
  onTimeFilterChange: (v: TimePreset) => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (v: StatusFilter) => void;
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
  /**
   * Optional "Clear filters" button — when provided, renders trailing
   * the row and drops the entire querystring on click. Hidden when
   * filters are page-scoped immutable (e.g. fixed agent).
   */
  onClearFilters?: () => void;
}

/**
 * Filter strip rendered above the task list in the master-detail view.
 *
 * Phase A: single horizontal row (search grows, dropdowns + time pills
 * trail right). Wraps naturally at narrower widths. The Origin pills
 * were removed — the Tasks page is standalone-only; workflow-origin
 * tasks surface on a separate (future) page.
 *
 * Phase 1.5 Block G adds the Status pill group + an explicit Clear
 * filters affordance to match Sessions; every chip/dropdown/input is
 * URL-driven now (state lives in the page).
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
    statusFilter,
    onStatusFilterChange,
    filterAgentNames,
    runtimes,
    hideAgentFilter,
    onClearFilters,
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
        <fieldset className="pills task-filters__pills" aria-label="Filter by task status">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s.value}
              type="button"
              className={`pills__btn${statusFilter === s.value ? " pills__btn--active" : ""}`}
              onClick={() => onStatusFilterChange(s.value)}
              aria-pressed={statusFilter === s.value}
              data-testid={`task-status-filter-${s.value}`}
            >
              {s.label}
            </button>
          ))}
        </fieldset>
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
        {onClearFilters && (
          <button
            type="button"
            className="btn btn--ghost task-filters__clear"
            onClick={onClearFilters}
            data-testid="clear-filters"
            title="Drop every filter and search term"
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      className="task-filters__search-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
