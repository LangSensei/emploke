import type { TaskRecord } from "../../api";
import { Modal } from "../../components/Modal";

interface DeleteConfirmModalProps {
  target: TaskRecord;
  /**
   * `true` = purge mode (also wipe workdir). `false` = archive (default;
   * only the metadata row goes). Reset to `false` on every new
   * `setDeleteTarget(...)`.
   */
  purge: boolean;
  busy: boolean;
  onPurgeChange: (purge: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Delete-confirm modal for a single task. State (`deleteTarget`,
 * `deletePurge`, `busy`) is owned by the parent (TasksPage) so that
 * a successful delete can clear the URL selection and refresh the
 * list in a single page-level callback. The modal itself is purely
 * presentational + an onConfirm callback.
 */
export function DeleteConfirmModal({
  target,
  purge,
  busy,
  onPurgeChange,
  onCancel,
  onConfirm,
}: DeleteConfirmModalProps) {
  return (
    <Modal open={true} onClose={onCancel} title="Delete task" size="default">
      <div className="modal__body">
        <p>
          Delete task <code>{target.id}</code>?
          {target.status === "running" ? " The subprocess will be killed first." : ""}
        </p>
        <p className="muted" style={{ fontSize: 12, margin: "6px 0 0 0" }}>
          By default, the workdir is preserved on disk so you can inspect the agent's output
          (stderr, artifacts, runtime event log) after the fact.
        </p>
        <label
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            fontSize: 13,
            marginTop: 10,
          }}
        >
          <input
            type="checkbox"
            checked={purge}
            onChange={(e) => onPurgeChange(e.target.checked)}
            disabled={busy}
          />
          Also remove files (cannot be undone)
        </label>
      </div>
      <div className="modal__footer">
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Deleting…" : purge ? "Delete and remove files" : "Delete"}
        </button>
      </div>
    </Modal>
  );
}
