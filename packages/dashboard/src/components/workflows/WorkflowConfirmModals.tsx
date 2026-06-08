import { useState } from "react";
import type { WorkflowHeaderWire } from "../../api";
import { Modal } from "../Modal";

export interface CancelWorkflowModalProps {
  target: WorkflowHeaderWire;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}

/**
 * Confirm modal for the Cancel-workflow action. Mirrors the
 * destructive-confirm shape used by
 * `components/schedules/ScheduleConfirmModals.tsx` (footer with a
 * Cancel + a danger primary button, error banner above the body). The
 * optional reason textarea lets the user attach a short audit trail
 * note that becomes the workflow's `outcomeReason` once the engine
 * settles the run into `cancelled`. The server treats `reason` as
 * optional — sending an empty/whitespace-only string omits the field
 * entirely so the engine writes its own default.
 */
export function CancelWorkflowModal({
  target,
  busy,
  error,
  onClose,
  onConfirm,
}: CancelWorkflowModalProps) {
  const [reason, setReason] = useState("");
  return (
    <Modal open={true} onClose={onClose} title="Cancel workflow" size="default">
      <div className="modal__body">
        {error && (
          <div
            className="alert alert--error"
            style={{ marginBottom: 10 }}
            data-testid="cancel-workflow-error"
          >
            ⚠️ {error}
          </div>
        )}
        <p>
          Cancel workflow <code>{target.id.slice(0, 8)}</code>? Any in-flight coordinator or task
          nodes will stop on the next tick. Already completed nodes are not reverted. This action
          cannot be undone.
        </p>
        <p className="muted" style={{ fontSize: 12, margin: "6px 0 0 0" }}>
          {target.brief}
        </p>
        <label htmlFor="cancel-workflow-reason" style={{ display: "block", marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            Reason (optional)
          </div>
          <textarea
            id="cancel-workflow-reason"
            className="input"
            style={{ width: "100%", fontFamily: "inherit", resize: "vertical" }}
            rows={3}
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Superseded by a follow-up workflow"
            data-testid="cancel-workflow-reason"
          />
        </label>
      </div>
      <div className="modal__footer">
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
          Keep running
        </button>
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => void onConfirm(reason.trim())}
          disabled={busy}
          data-testid="cancel-workflow-confirm"
        >
          {busy ? "Cancelling…" : "Cancel workflow"}
        </button>
      </div>
    </Modal>
  );
}
