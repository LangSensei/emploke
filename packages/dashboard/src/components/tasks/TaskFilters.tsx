import type { AgentEntry } from "@emploke/catalog";
import {
  ALL_AGENTS,
  ALL_RUNTIMES,
  ORIGIN_PRESETS,
  type OriginPreset,
  TIME_PRESETS,
  type TimePreset,
} from "./shared";

export interface TaskFiltersProps {
  idQuery: string;
  onIdQueryChange: (v: string) => void;
  agentFilter: string;
  onAgentFilterChange: (v: string) => void;
  runtimeFilter: string;
  onRuntimeFilterChange: (v: string) => void;
  timeFilter: TimePreset;
  onTimeFilterChange: (v: TimePreset) => void;
  originFilter: OriginPreset;
  onOriginFilterChange: (v: OriginPreset) => void;
  agents: AgentEntry[];
  filterAgentNames: string[];
  runtimes: string[];
}

/**
 * Filter strip rendered above the task list in the master-detail view.
 *
 * Bug-bash iter-1 (F1/F2): compacted to two rows max so the task list
 * is always visible above the fold.
 *   row 1: search input (single line, search-icon prefix)
 *   row 2: Agent ▾ · Runtime ▾ · Origin pills · Time pills (wraps to
 *          row 3 only on narrow widths)
 *
 * Previously each filter group sat on its own row and the search was
 * a flex-grow item inside a `flex-direction: column` container — which
 * caused the input to stretch vertically and the panel to consume
 * ~480px of the sidebar.
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
    originFilter,
    onOriginFilterChange,
    filterAgentNames,
    runtimes,
  } = props;
  return (
    <div className="task-filters">
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
      <div className="task-filters__row task-filters__row--compact">
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
          {ORIGIN_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              className={`pills__btn${originFilter === p.value ? " pills__btn--active" : ""}`}
              onClick={() => onOriginFilterChange(p.value)}
              aria-pressed={originFilter === p.value}
            >
              {p.label}
            </button>
          ))}
        </div>
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
