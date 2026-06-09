/**
 * Single-source-of-truth magnifying-glass SVG for the search-input
 * adornments on both `TaskFilters` and `WorkflowFilters` (and any
 * future filter strip that mirrors the same search-input slot).
 *
 * Convention:
 *   - This component owns only the SVG markup + viewBox / stroke
 *     attributes. The positioning (`task-filters__search-icon`) and
 *     the surrounding wrap stay on the consumer side, so each filter
 *     strip can control its own layout without forking the icon.
 *   - The shared className `task-filters__search-icon` keeps the
 *     name despite serving both Tasks and Workflows — both pages
 *     reuse the `task-*` filter classes so the same CSS rule
 *     covers them both.
 *
 * Imported by `components/tasks/TaskFilters.tsx` and
 * `components/workflows/WorkflowFilters.tsx`.
 */
export function SearchIcon() {
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
