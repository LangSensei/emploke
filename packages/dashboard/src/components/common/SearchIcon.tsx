/**
 * Search-input adornment icon, shared by `TaskFilters` and
 * `WorkflowFilters` (and, in principle, any future filter strip that
 * mirrors the same search-input slot).
 *
 * The icon is rendered absolutely inside the search wrap so it sits
 * inside the input's left padding. The viewBox / stroke / className
 * shape matches what both filter components carried inline before —
 * keeping the className `task-filters__search-icon` on the consumer
 * side preserves the generic, reusable CSS rule (per the v2.3
 * "reuse `task-*` classes" pattern).
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
