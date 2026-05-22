import type { TaskRecord } from "../../api";
import { Modal } from "../Modal";

export interface CancelTaskModalProps {
  target: TaskRecord;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}

/**
 * Cancel-confirm modal — extracted from `pages/Tasks.tsx` so the
 * shell stays under the 300-line budget. Behaviour is unchanged from
 * the pre-mission-A implementation: SIGTERM the running subprocess
 * after a confirm click, surface inline errors, no-op when busy.
 */
export function CancelTaskModal({ target, busy, error, onClose, onConfirm }: CancelTaskModalProps) {
  return (
    <Modal open={true} onClose={onClose} title="Cancel task" size="default">
      <div className="modal__body">
        {error && (
          <div className="alert alert--error" style={{ marginBottom: 10 }}>
            ⚠️ {error}
          </div>
        )}
        <p>
          Cancel task <code>{target.id}</code>? Sends SIGTERM and marks the task as cancelled.
          Partial output may be lost.
        </p>
        <p className="muted" style={{ fontSize: 12, margin: "6px 0 0 0" }}>
          {target.brief}
        </p>
      </div>
      <div className="modal__footer">
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
          Close
        </button>
        <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Cancelling…" : "Cancel task"}
        </button>
      </div>
    </Modal>
  );
}

export interface DeleteTaskModalProps {
  target: TaskRecord;
  purge: boolean;
  onPurgeChange: (v: boolean) => void;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}

/**
 * Delete-confirm modal — the row-level Trash button and the detail
 * panel Delete button both route through here. The `purge` checkbox
 * forwards through to `deleteTask(id, { purge })` so the operator
 * can also wipe the workdir on disk.
 */
export function DeleteTaskModal({
  target,
  purge,
  onPurgeChange,
  busy,
  onClose,
  onConfirm,
}: DeleteTaskModalProps) {
  return (
    <Modal open={true} onClose={onClose} title="Delete task" size="default">
      <div className="modal__body">
        <p>
          Delete task <code>{target.id}</code>?
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
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Deleting…" : purge ? "Delete and remove files" : "Delete"}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Convenience wrapper that renders both the cancel and the delete
 * confirm modal conditionally (each on its respective `*Target`
 * being non-null). Keeps the shell `pages/Tasks.tsx` from having
 * to thread both pairs of props through twice.
 */
export interface TaskConfirmModalsHostProps {
  cancelTarget: TaskRecord | null;
  cancelBusy: boolean;
  cancelError: string | null;
  onCloseCancel: () => void;
  onConfirmCancel: () => void | Promise<void>;
  deleteTarget: TaskRecord | null;
  deleteBusy: boolean;
  deletePurge: boolean;
  onDeletePurgeChange: (v: boolean) => void;
  onCloseDelete: () => void;
  onConfirmDelete: () => void | Promise<void>;
}

export function TaskConfirmModalsHost(props: TaskConfirmModalsHostProps) {
  return (
    <>
      {props.cancelTarget && (
        <CancelTaskModal
          target={props.cancelTarget}
          busy={props.cancelBusy}
          error={props.cancelError}
          onClose={props.onCloseCancel}
          onConfirm={props.onConfirmCancel}
        />
      )}
      {props.deleteTarget && (
        <DeleteTaskModal
          target={props.deleteTarget}
          purge={props.deletePurge}
          onPurgeChange={props.onDeletePurgeChange}
          busy={props.deleteBusy}
          onClose={props.onCloseDelete}
          onConfirm={props.onConfirmDelete}
        />
      )}
    </>
  );
}
