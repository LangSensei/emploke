import type { ReactNode } from "react";
import { TrashIcon } from "./Icons";

interface EntryRow {
  name: string;
  description: string;
  version: string;
  status: "ready" | "disabled";
  missingDeps?: readonly string[];
}

interface EntryTableProps {
  items: EntryRow[];
  emptyTitle: string;
  emptyHint?: ReactNode;
  onRemove?: (name: string) => void;
}

export function EntryTable({ items, emptyTitle, emptyHint, onRemove }: EntryTableProps) {
  if (items.length === 0) {
    return (
      <div className="empty">
        <div className="empty__icon">∅</div>
        <h3 className="empty__title">{emptyTitle}</h3>
        {emptyHint && <p className="empty__hint">{emptyHint}</p>}
      </div>
    );
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Description</th>
          <th>Version</th>
          <th>Status</th>
          {onRemove && <th className="actions-col" />}
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.name}>
            <td className="name-cell">{item.name}</td>
            <td className="desc-cell">{item.description}</td>
            <td className="version-cell">{item.version}</td>
            <td>
              {item.status === "ready" ? (
                <span className="badge badge--ready">✓ ready</span>
              ) : (
                <span
                  className="badge badge--disabled"
                  title={item.missingDeps?.length ? `Missing: ${item.missingDeps.join(", ")}` : ""}
                >
                  ⛔ disabled
                </span>
              )}
            </td>
            {onRemove && (
              <td className="actions-cell">
                <button
                  type="button"
                  className="btn btn--ghost btn--icon"
                  onClick={() => onRemove(item.name)}
                  aria-label={`Remove ${item.name}`}
                  title="Remove"
                >
                  <TrashIcon />
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
