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
 * Lifted from the page toolbar to live with the list it filters; the
 * shell page now only owns the action buttons (Refresh / Dispatch).
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
      <input
        id="task-id-filter"
        type="search"
        value={idQuery}
        onChange={(e) => onIdQueryChange(e.target.value)}
        placeholder="Search task id…"
        className="input task-filters__search"
        aria-label="Search by task id"
      />
      <div className="task-filters__row">
        <label htmlFor="task-agent-filter" className="muted task-filters__label">
          Agent
        </label>
        <select
          id="task-agent-filter"
          value={agentFilter}
          onChange={(e) => onAgentFilterChange(e.target.value)}
          className="select"
        >
          <option value={ALL_AGENTS}>All</option>
          {filterAgentNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <label htmlFor="task-runtime-filter" className="muted task-filters__label">
          Runtime
        </label>
        <select
          id="task-runtime-filter"
          value={runtimeFilter}
          onChange={(e) => onRuntimeFilterChange(e.target.value)}
          className="select"
          disabled={runtimes.length === 0}
        >
          <option value={ALL_RUNTIMES}>All</option>
          {runtimes.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      <div className="task-filters__row">
        <span className="muted task-filters__label">Created</span>
        <div className="pills">
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
      <div className="task-filters__row">
        <span className="muted task-filters__label">Origin</span>
        <div className="pills">
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
      </div>
    </div>
  );
}
