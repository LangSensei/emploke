/**
 * Loading skeleton for the workflow detail right-pane. Approximates
 * the resolved {@link WorkflowView} chrome — title row, meta-row
 * chips, statbar, tab strip, and body region — so the pane reserves
 * the same visual real estate while the per-workflow fetch is in
 * flight. Without this, switching workflows briefly collapses the
 * pane to a single line of text before snapping back to the full
 * three-region layout.
 *
 * Uses the existing `.skeleton` shimmer block — no new animation
 * primitive is introduced.
 *
 * Accessibility: the wrapper exposes `role="status"` + `aria-busy`
 * + a `polite` live region so screen readers announce the loading
 * state once. Inner shape elements are `aria-hidden`.
 */
export function WorkflowDetailSkeleton() {
  return (
    <aside
      className="tasks-pane__detail workflow-detail-skeleton"
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading workflow"
      data-testid="workflow-detail-skeleton"
    >
      <div className="workflow-detail-skeleton__inner" aria-hidden="true">
        <header className="task-detail__head workflow-detail-skeleton__head">
          <div className="task-detail__title-row">
            <span className="skeleton workflow-detail-skeleton__title" />
          </div>
          <div className="task-detail__meta-row workflow-detail-skeleton__meta-row">
            <span className="skeleton workflow-detail-skeleton__chip" />
            <span className="skeleton workflow-detail-skeleton__chip workflow-detail-skeleton__chip--wide" />
          </div>
          <div className="task-detail__statbar workflow-detail-skeleton__statbar">
            <span className="skeleton workflow-detail-skeleton__stat" />
            <span className="skeleton workflow-detail-skeleton__stat" />
            <span className="skeleton workflow-detail-skeleton__stat" />
          </div>
        </header>
        <div className="task-tabs workflow-detail-skeleton__tabs">
          <span className="skeleton workflow-detail-skeleton__tab" />
          <span className="skeleton workflow-detail-skeleton__tab" />
          <span className="skeleton workflow-detail-skeleton__tab" />
        </div>
        <div className="workflow-detail-skeleton__body">
          <span className="skeleton workflow-detail-skeleton__line workflow-detail-skeleton__line--long" />
          <span className="skeleton workflow-detail-skeleton__line workflow-detail-skeleton__line--med" />
          <span className="skeleton workflow-detail-skeleton__line workflow-detail-skeleton__line--short" />
          <span className="skeleton workflow-detail-skeleton__line workflow-detail-skeleton__line--med" />
        </div>
      </div>
    </aside>
  );
}
