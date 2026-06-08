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
 * optional reason textarea is forwarded to the server today as a
 * forward-compat hint — the wire `CancelWorkflowBody` keeps the field
 * so once the substrate surfaces a cancel reason (#334 follow-up) the
 * UI does not have to round-trip through another wire change.
 * The server discards the reason in M2 and writes its own default.
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
