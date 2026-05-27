import type { AgentEntry } from "@emploke/catalog";
import { ALL_AGENTS, ALL_ENABLED, ENABLED_FILTERS, type EnabledFilter } from "./shared";

export interface SchedulesFiltersProps {
  agentFilter: string;
  onAgentFilterChange: (v: string) => void;
  enabledFilter: EnabledFilter;
  onEnabledFilterChange: (v: EnabledFilter) => void;
  agents: AgentEntry[];
  filterAgentNames: string[];
}

/**
 * Filter strip rendered above the schedule list. Two affordances:
 * agent filter (FQN dropdown) + enabled toggle (All / Enabled /
 * Paused). Mirrors `TaskFilters` layout but skips search and time
 * preset — schedules are a small set and the `nextFireAt` ordering
 * already foregrounds the most relevant rows.
 */
export function SchedulesFilters({
  agentFilter,
  onAgentFilterChange,
  enabledFilter,
  onEnabledFilterChange,
  filterAgentNames,
}: SchedulesFiltersProps) {
  return (
    <div className="task-filters">
      <div className="task-filters__row task-filters__row--compact">
        <select
          id="schedule-agent-filter"
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
        <fieldset
          className="pills task-filters__pills"
          style={{ border: 0, margin: 0, padding: 0 }}
        >
          <legend
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: "hidden",
              clip: "rect(0, 0, 0, 0)",
              whiteSpace: "nowrap",
              border: 0,
            }}
          >
            Filter by state
          </legend>
          {ENABLED_FILTERS.map((p) => (
            <button
              key={p.value}
              type="button"
              className={`pills__btn${enabledFilter === p.value ? " pills__btn--active" : ""}`}
              onClick={() => onEnabledFilterChange(p.value)}
              aria-pressed={enabledFilter === p.value}
            >
              {p.label}
            </button>
          ))}
        </fieldset>
        <div style={{ flex: 1 }} />
        {agentFilter !== ALL_AGENTS || enabledFilter !== ALL_ENABLED ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              onAgentFilterChange(ALL_AGENTS);
              onEnabledFilterChange(ALL_ENABLED);
            }}
          >
            Clear filters
          </button>
        ) : null}
      </div>
    </div>
  );
}
