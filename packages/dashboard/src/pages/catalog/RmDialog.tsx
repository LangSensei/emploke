import type { CatalogKind } from "@emploke/contracts";
import { Modal } from "../../components/Modal";
import { CATALOG_VERBS } from "./CATALOG_VERBS";

interface RmDialogProps {
  kind: CatalogKind;
  /** Target fqn; `null` ⇒ dialog closed. */
  name: string | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * Generic confirm-and-delete dialog for any catalog kind. The kind's
 * prose label (e.g. "Agent" / "Skill" / "MCP") comes from
 * {@link CATALOG_VERBS} so the dialog has no hard-coded per-kind
 * branches.
 */
export function RmDialog({ kind, name, busy, error, onClose, onConfirm }: RmDialogProps) {
  const verbs = CATALOG_VERBS[kind];
  return (
    <Modal open={name !== null} onClose={onClose} title={`Remove ${verbs.title}`}>
      <div className="modal__body">
        <p>
          Remove <code>{name}</code>? This deletes the entry from the catalog. Other entries that
          declare it as a dependency will be marked <strong>disabled</strong>.
        </p>
        {error && <div className="alert alert--error">⚠ {error}</div>}
      </div>
      <div className="modal__footer">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Removing..." : "Remove"}
        </button>
      </div>
    </Modal>
  );
}
