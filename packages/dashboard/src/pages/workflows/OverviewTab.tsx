import type { ReactNode } from "react";
import type { WorkflowHeaderWire } from "../../api";
import { MarkdownSummary } from "../../components/tasks/TaskDetail/MarkdownSummary";

export interface OverviewTabProps {
  workflow: WorkflowHeaderWire;
}

/**
 * Overview tab — workflow narrative.
 *
 * v2.2 redesign: vertical stack of (optional) state strip + Summary
 * card + Details card. Mirrors `components/tasks/TaskDetail/OverviewTab.tsx`
 * so users moving between the Task and Workflow detail panes find the
 * same chrome.
 *
 *   - Summary holds `success.output` (the coordinator's free-form
 *     terminal summary). Rendered through {@link MarkdownSummary} so
 *     headings / lists / inline code in the coord's output show up.
 *   - Details holds the original `workflow.details` brief from
 *     creation time. Rendered as `<pre>` (matches task's Details
 *     card) so whitespace-sensitive operator notes stay legible.
 *   - State strip is conditional: typed failure callout for `failed`,
 *     muted info note for `cancelled`, "Run succeeded with no recorded
 *     summary" for succeeded-without-output, "Run ended; no payload"
 *     for terminal-but-NULL-payload (pre-v2.2 legacy rows), running
 *     hint for in-flight.
 *
 * The `brief` was rendered as a body section in v2.1; it now lives
 * only in `WorkflowView`'s `<h2 class="workflow-detail__title">` (the
 * page title), so we don't repeat the same string twice in the same
 * pane.
 *
 * Header chrome (status badge, meta chips) lives in the parent
 * {@link import("./WorkflowView").WorkflowView} so the tab body stays
 * purely about the workflow's narrative.
 */
export function OverviewTab({ workflow }: OverviewTabProps) {
  const summaryText =
    typeof workflow.success?.output === "string" ? workflow.success.output.trim() : "";
  const hasSummary = summaryText.length > 0;
  const detailsText = workflow.details?.trim() ?? "";
  const hasDetails = detailsText.length > 0;
  const metadataEntries = Object.entries(workflow.metadata ?? {});
  const hasMetadata = metadataEntries.length > 0;

  const strip = renderStateStrip({ workflow, hasSummary });

  return (
    <div className="overview-tab" data-testid="workflow-overview-tab">
      {strip}
      {hasSummary && (
        <OverviewCard title="Summary" className="overview-card--summary">
          <div data-testid="workflow-overview-summary">
            <MarkdownSummary source={summaryText} />
          </div>
        </OverviewCard>
      )}
      {hasDetails && (
        <OverviewCard title="Details" className="overview-card--details">
          <pre className="overview-card__pre" data-testid="workflow-overview-details">
            {detailsText}
          </pre>
        </OverviewCard>
      )}
      {hasMetadata && (
        <OverviewCard title="Metadata" className="overview-card--metadata">
          <dl className="workflow-overview__metadata" data-testid="workflow-overview-metadata">
            {metadataEntries.map(([key, value]) => (
              <div className="workflow-overview__meta-row" key={key}>
                <dt>{key}</dt>
                <dd>
                  <code>{stringifyValue(value)}</code>
                </dd>
              </div>
            ))}
          </dl>
        </OverviewCard>
      )}
      {!hasSummary && !hasDetails && !hasMetadata && strip === null && (
        <p className="overview-tab__no-details muted" data-testid="workflow-overview-empty">
          No details available.
        </p>
      )}
    </div>
  );
}

/**
 * Pick the contextual strip rendered above the cards. Returns `null`
 * for the succeeded-with-output state — that state is "pure result,
 * no commentary needed".
 *
 * Branch table:
 *   - failed + failure → typed FailureStrip
 *   - cancelled + cancellation → cancellation note
 *   - succeeded + hasSummary → null
 *   - succeeded + no summary → "Run succeeded with no recorded summary"
 *   - terminal + payload column NULL (legacy row) → legacy note
 *   - running → "switch to Activity / Graph" hint
 */
function renderStateStrip({
  workflow,
  hasSummary,
}: {
  workflow: WorkflowHeaderWire;
  hasSummary: boolean;
}): ReactNode {
  if (workflow.status === "failed") {
    if (workflow.failure) {
      return <FailureStrip failure={workflow.failure} />;
    }
    return (
      <div
        className="alert alert--info overview-tab__strip"
        data-testid="workflow-overview-legacy-note"
      >
        Run ended; no payload was recorded (legacy row).
      </div>
    );
  }
  if (workflow.status === "cancelled") {
    if (workflow.cancellation) {
      const message = workflow.cancellation.message || "Workflow was cancelled.";
      return (
        <div
          className="alert alert--info overview-tab__strip"
          data-testid="workflow-overview-cancellation"
        >
          {message}
        </div>
      );
    }
    return (
      <div
        className="alert alert--info overview-tab__strip"
        data-testid="workflow-overview-legacy-note"
      >
        Run ended; no payload was recorded (legacy row).
      </div>
    );
  }
  if (workflow.status === "succeeded") {
    if (hasSummary) return null;
    if (workflow.success === undefined) {
      // Terminal succeeded, but no payload column at all — pre-v2.2
      // row migrated from the gap-tracking days; surface the legacy
      // note rather than the friendlier "no summary" line so the
      // operator knows why the Summary card is absent.
      //
      // v2.3: unified to the same .alert.alert--info.overview-tab__strip
      // wrapper the failed/cancelled legacy branches use, so all three
      // legacy-payload states render with identical visual chrome. The
      // earlier <p class="overview-tab__no-summary"> split the look
      // for no good reason — the situation it described (operator-
      // facing "your row is missing data") is the same in all cases.
      return (
        <div
          className="alert alert--info overview-tab__strip"
          data-testid="workflow-overview-legacy-note"
        >
          Run ended; no payload was recorded (legacy row).
        </div>
      );
    }
    return (
      <p className="overview-tab__no-summary" data-testid="workflow-overview-no-summary">
        Run succeeded with no recorded summary.
      </p>
    );
  }
  // Running.
  return (
    <div
      className="alert alert--info overview-tab__strip overview-tab__running-hint"
      data-testid="workflow-overview-running-hint"
    >
      Workflow is {workflow.status}. Switch to the Graph tab to watch nodes light up, or Activity on
      a node for live runtime output.
    </div>
  );
}

/**
 * Pinned-title card with an internally-scrolling body. Shared chrome
 * between Summary / Details / Metadata so all three read as equals.
 * Reuses the same `.overview-card*` selectors that the Task detail
 * pane defines, so the visual treatment lines up exactly.
 */
function OverviewCard({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`overview-card${className ? ` ${className}` : ""}`}>
      <header className="overview-card__head">
        <h3 className="overview-card__title">{title}</h3>
      </header>
      <div className="overview-card__body">{children}</div>
    </section>
  );
}

/**
 * Render a workflow failure callout with `failure.kind` chip + the
 * coordinator-supplied message. Mirrors the Task `FailureStrip` shape
 * but specialised for `WorkflowFailureWire` (kind: 'coordinator').
 */
function FailureStrip({ failure }: { failure: NonNullable<WorkflowHeaderWire["failure"]> }) {
  return (
    <div
      className="alert alert--error overview-tab__failure-callout"
      data-testid="workflow-overview-failure-callout"
    >
      <div className="overview-tab__failure-head">
        <strong>Failure · {failure.kind}</strong>
      </div>
      <p className="overview-tab__failure-message" data-testid="workflow-overview-failure-message">
        {failure.message}
      </p>
    </div>
  );
}

function stringifyValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
