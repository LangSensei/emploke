import type { WorkflowHeaderWire } from "../../api";

export interface OverviewTabProps {
  workflow: WorkflowHeaderWire;
}

/**
 * Overview tab — high-density text summary of the workflow:
 * `brief`, optional `details` block, outcome banner for
 * terminal-non-succeeded states (the `#334` substrate gap means we
 * surface a placeholder), and a metadata viewer if the caller seeded
 * any custom metadata keys.
 *
 * Header chrome (status badge, meta chips, Cancel CTA) lives in the
 * parent {@link WorkflowView} so the tab body stays purely about the
 * workflow's narrative.
 */
export function OverviewTab({ workflow }: OverviewTabProps) {
  const hasDetails = workflow.details !== undefined && workflow.details !== "";
  const metadataEntries = Object.entries(workflow.metadata ?? {});

  return (
    <div className="workflow-overview" data-testid="workflow-overview-tab">
      <section className="workflow-overview__section">
        <h3 className="workflow-overview__h">Brief</h3>
        <p className="workflow-overview__brief" data-testid="workflow-overview-brief">
          {workflow.brief}
        </p>
      </section>

      {hasDetails ? (
        <section className="workflow-overview__section">
          <h3 className="workflow-overview__h">Details</h3>
          <pre className="workflow-overview__details" data-testid="workflow-overview-details">
            {workflow.details}
          </pre>
        </section>
      ) : null}

      {workflow.status === "failed" || workflow.status === "cancelled" ? (
        <section className="workflow-overview__section">
          <div className="alert alert--info" data-testid="workflow-overview-outcome">
            <strong>Outcome:</strong> Reason unavailable — substrate gap tracked in #334.
          </div>
        </section>
      ) : null}

      {metadataEntries.length > 0 ? (
        <section className="workflow-overview__section">
          <h3 className="workflow-overview__h">Metadata</h3>
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
        </section>
      ) : null}
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
