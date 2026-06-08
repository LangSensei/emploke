import { ALL_AGENTS, TIME_PRESETS, type TimePreset } from "../tasks/shared";

export interface WorkflowFiltersProps {
  idQuery: string;
  onIdQueryChange: (v: string) => void;
  agentFilter: string;
  onAgentFilterChange: (v: string) => void;
  timeFilter: TimePreset;
  onTimeFilterChange: (v: TimePreset) => void;
  /**
   * Coordinator-agent FQNs to populate the agent `<select>` with. The
   * Workflows page derives this from the current `workflows` rows'
   * `coordinatorAgent` field (dedupe + sort) rather than from the
   * global agents catalogue — there is no marketplace flag on agents
   * declaring "I am a coordinator", so the operational answer is "any
   * agent that has actually run as a coordinator in this workspace".
   * The page is responsible for keeping the currently-selected value
   * (when not `ALL_AGENTS`) in this list even if no row currently
   * matches it, so the dropdown stays consistent while a filter is
   * active.
   */
  filterAgentNames: string[];
}

/**
 * Filter strip rendered above the workflow list in the master-detail
 * view. Same three-slot shape as `TaskFilters` (search id, agent
 * select, time pills) minus the runtime select — workflows have no
 * runtime concept; the kind of node runner is decided per-node by
 * the substrate, not per-workflow. Reuses the `task-filters*` CSS
 * classes verbatim so both pages stay visually identical.
 */
export function WorkflowFilters(props: WorkflowFiltersProps) {
  const {
    idQuery,
    onIdQueryChange,
    agentFilter,
    onAgentFilterChange,
    timeFilter,
    onTimeFilterChange,
    filterAgentNames,
  } = props;
  return (
    <div className="task-filters">
      <div className="task-filters__row task-filters__row--compact">
        <div className="task-filters__search-wrap">
          <SearchIcon />
          <input
            id="workflow-id-filter"
            type="search"
            value={idQuery}
            onChange={(e) => onIdQueryChange(e.target.value)}
            placeholder="Search workflow id…"
            className="input task-filters__search"
            aria-label="Search by workflow id"
          />
        </div>
        <select
          id="workflow-agent-filter"
          aria-label="Filter by coordinator agent"
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
