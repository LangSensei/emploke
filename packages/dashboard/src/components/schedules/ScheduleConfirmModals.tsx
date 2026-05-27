import type { ScheduleView } from "../../api";
import { Modal } from "../Modal";

export interface DeleteScheduleModalProps {
  target: ScheduleView;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}

/**
 * Delete-confirm modal — invoked from the schedule detail panel's
 * Delete button. Deleting is destructive (cron stops firing
 * immediately and the row vanishes from the list); we keep the copy
 * explicit about that. Already-fired tasks the schedule launched are
 * preserved — only the trigger entity is removed.
 */
export function DeleteScheduleModal({
  target,
  busy,
  error,
  onClose,
  onConfirm,
}: DeleteScheduleModalProps) {
  return (
    <Modal open={true} onClose={onClose} title="Delete schedule" size="default">
      <div className="modal__body">
        {error && (
          <div className="alert alert--error" style={{ marginBottom: 10 }}>
            ⚠️ {error}
          </div>
        )}
        <p>
          Delete schedule <code>{target.name}</code>? The trigger stops firing immediately and the
          entry is removed from the list. Tasks the schedule already produced stay in the workspace
          history.
        </p>
        <p className="muted" style={{ fontSize: 12, margin: "6px 0 0 0" }}>
          {target.trigger.expr} · {target.target.agent}
        </p>
      </div>
      <div className="modal__footer">
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Deleting…" : "Delete schedule"}
        </button>
      </div>
    </Modal>
  );
}
