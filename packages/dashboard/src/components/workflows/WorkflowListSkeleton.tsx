/**
 * Loading skeleton for the workflow master list. Renders a small stack
 * of placeholder rows that approximate the resolved {@link
 * WorkflowListItem} shape (status pill + headline + meta line + id
 * row) so the chrome doesn't visibly reflow when the data arrives.
 *
 * Uses the existing `.skeleton` shimmer block (originally introduced
 * for the AgentsList activity tag) — no new animation primitive is
 * introduced.
 *
 * Accessibility: the wrapper exposes `role="status"` + `aria-busy=true`
 * so screen readers announce the loading state via a polite live
 * region. Decorative bars themselves are `aria-hidden` so the screen
 * reader doesn't try to narrate the placeholder shapes.
 */
const ROW_COUNT = 4;

export interface WorkflowListSkeletonProps {
  /** Optional row count override (mostly for tests). Defaults to 4. */
  rowCount?: number;
}

export function WorkflowListSkeleton({ rowCount = ROW_COUNT }: WorkflowListSkeletonProps = {}) {
  return (
    <div
      className="workflow-list-skeleton"
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading workflows"
      data-testid="workflow-list-skeleton"
    >
      <ul className="task-list workflow-list-skeleton__list" aria-hidden="true">
        {Array.from({ length: rowCount }, (_, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: stable placeholder rows
            key={i}
            className="task-list__item workflow-list-skeleton__row"
            data-testid="workflow-list-skeleton-row"
          >
            <div className="task-list__item-select workflow-list-skeleton__cell">
              <span className="workflow-list-skeleton__head">
                <span className="skeleton workflow-list-skeleton__badge" />
              </span>
              <span className="skeleton workflow-list-skeleton__headline" />
              <span className="skeleton workflow-list-skeleton__meta" />
              <span className="skeleton workflow-list-skeleton__id" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
