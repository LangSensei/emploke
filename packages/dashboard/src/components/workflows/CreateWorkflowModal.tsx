import type { AgentEntry } from "@emploke/contracts";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  type CreateWorkflowBody,
  createWorkflow,
  type WorkflowHeaderWire,
} from "../../api";
import { Modal } from "../Modal";

export interface CreateWorkflowModalProps {
  open: boolean;
  agents: AgentEntry[];
  onClose: () => void;
  onCreated: (workflow: WorkflowHeaderWire) => void;
}

/**
 * "New workflow" modal — dispatches a coordinator-only workflow. The
 * coordinator agent is responsible for proposing the next node(s); the
 * dashboard does not pre-build the DAG. Mirrors the structural shape
 * of `components/schedules/CreateScheduleModal.tsx` (mount-effect
 * agent reseed, submit error banner, close-on-success).
 *
 * `brief` is required; `details` is optional. The agent dropdown
 * defaults to the first installed agent on open; switching agents
 * before submit is supported.
 *
 * The dropdown is filtered to coord-eligible agents only — i.e.
 * agents whose `AgentEntry.coordEligible` flag is true. That flag is
 * computed server-side from the agent's `dependencies.agents`
 * dispatch menu, which is the workflow substrate's coordinator-
 * capability invariant; the modal MUST NOT re-derive the predicate
 * here or it would silently drift from the substrate.
 *
 * If the server rejects the submit with a coord-agent-not-eligible
 * envelope (`ApiError` whose `field === "coordinatorAgent"`), the
 * error renders inline next to the agent select rather than as a
 * full-form banner — the form stays submittable so the user can pick
 * a different agent without re-typing the brief.
 */
export function CreateWorkflowModal({
  open,
  agents,
  onClose,
  onCreated,
}: CreateWorkflowModalProps) {
  const [brief, setBrief] = useState("");
  const [details, setDetails] = useState("");
  const [agent, setAgent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [agentFieldError, setAgentFieldError] = useState<string | null>(null);

  const coordEligibleAgents = useMemo(() => agents.filter((a) => a.coordEligible), [agents]);

  useEffect(() => {
    if (!open) return;
    setAgent((prev) => (prev !== "" ? prev : (coordEligibleAgents[0]?.agent.fqn ?? "")));
  }, [open, coordEligibleAgents]);

  useEffect(() => {
    if (!open) {
      setSubmitting(false);
      setSubmitError(null);
      setAgentFieldError(null);
    }
  }, [open]);

  const canSubmit = !submitting && brief.trim() !== "" && agent !== "";

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    setAgentFieldError(null);
    try {
      const body: CreateWorkflowBody = {
        brief: brief.trim(),
        coordinatorAgent: agent,
        ...(details.trim() !== "" ? { details: details.trim() } : {}),
      };
      const created = await createWorkflow(body);
      // Reset transient form state BEFORE handing off so a re-open
      // starts clean. `onCreated` will navigate via the page's URL
      // writer, which in turn unmounts the modal.
      setBrief("");
      setDetails("");
      onCreated(created);
      onClose();
    } catch (err) {
      // Pin field-scoped rejections inline next to the matching
      // input (the server tells us which field via the structured
      // 4xx envelope); everything else falls back to the form-level
      // banner. The error text is the server-provided message —
      // never re-authored client-side.
      if (err instanceof ApiError && err.field === "coordinatorAgent") {
        setAgentFieldError(err.message);
      } else {
        setSubmitError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New workflow" size="large">
      <form onSubmit={onSubmit} data-testid="create-workflow-form">
        <div className="modal__body">
          <label htmlFor="new-workflow-agent">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Coordinator agent
            </div>
            <select
              id="new-workflow-agent"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              disabled={submitting || coordEligibleAgents.length === 0}
              className="select select--full"
              data-testid="create-workflow-agent"
              aria-describedby={agentFieldError !== null ? "new-workflow-agent-error" : undefined}
              aria-invalid={agentFieldError !== null || undefined}
            >
              {coordEligibleAgents.length === 0 && (
                <option value="">(no coord-eligible agents installed)</option>
              )}
              {coordEligibleAgents.map((a) => (
                <option key={a.agent.fqn} value={a.agent.fqn}>
                  {a.agent.fqn}
                </option>
              ))}
            </select>
          </label>
          {agentFieldError !== null && (
            <div
              id="new-workflow-agent-error"
              role="alert"
              className="alert alert--error"
              style={{ marginTop: 4, fontSize: 12 }}
              data-testid="create-workflow-agent-error"
            >
              ⚠️ {agentFieldError}
            </div>
          )}
          <label htmlFor="new-workflow-brief" style={{ display: "block", marginTop: 12 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Brief
            </div>
            <input
              id="new-workflow-brief"
              type="text"
              className="input"
              style={{ width: "100%" }}
              value={brief}
              maxLength={200}
              disabled={submitting}
              placeholder="One-line description the coordinator will receive"
              onChange={(e) => setBrief(e.target.value)}
              data-testid="create-workflow-brief"
            />
          </label>
          <label htmlFor="new-workflow-details" style={{ display: "block", marginTop: 12 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Details (optional)
            </div>
            <textarea
              id="new-workflow-details"
              className="input"
              style={{ width: "100%", fontFamily: "inherit", resize: "vertical" }}
              rows={5}
              value={details}
              disabled={submitting}
              placeholder="Multi-line instructions. Markdown OK."
              onChange={(e) => setDetails(e.target.value)}
              data-testid="create-workflow-details"
            />
          </label>
          {submitError !== null && (
            <div
              className="alert alert--error"
              style={{ marginTop: 8 }}
              data-testid="create-workflow-submit-error"
            >
              ⚠️ {submitError}
            </div>
          )}
        </div>
        <div className="modal__footer">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={!canSubmit}
            data-testid="create-workflow-submit"
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
