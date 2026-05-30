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
 * Delete button. Deleting is destructive: the trigger stops firing
 * immediately AND every historical task this schedule produced is
 * removed from the workspace (a schedule's history is unreachable
 * once the trigger is gone — there's no UI path to an orphaned task
 * — so we cascade rather than leak rows). Tasks currently in flight
 * are protected by the server's 409 pre-flight check; they are never
 * touched by the cascade.
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
          entry is removed from the list. All historical task runs from this schedule will also be
          removed. This cannot be undone.
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
