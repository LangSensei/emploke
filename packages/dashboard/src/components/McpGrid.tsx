import type { McpItem } from "../api";
import { TrashIcon } from "./Icons";

interface McpGridProps {
  mcps: McpItem[];
  onEdit: (name: string) => void;
  onRemove: (name: string) => void;
}

export function McpGrid({ mcps, onEdit, onRemove }: McpGridProps) {
  if (mcps.length === 0) {
    return (
      <div className="empty">
        <div className="empty__icon">∅</div>
        <h3 className="empty__title">No MCPs installed</h3>
        <p className="empty__hint">MCPs are JSON server configs referenced by skills/agents.</p>
      </div>
    );
  }
  return (
    <div className="card-grid">
      {mcps.map((m) => (
        // biome-ignore lint/a11y/useSemanticElements: card has nested Remove <button>; nesting buttons is invalid HTML
        <div
          key={m.name}
          className="card-grid__item"
          role="button"
          tabIndex={0}
          onClick={() => onEdit(m.name)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onEdit(m.name);
            }
          }}
          title={`Click to edit ${m.name}`}
        >
          <div className="card-grid__top">
            <span className="card-grid__name" title={m.name}>
              {m.name}
            </span>
          </div>
          <p className="card-grid__desc card-grid__desc--mono" title={m.path ?? undefined}>
            {m.path ?? <em>no path</em>}
          </p>
          <div className="card-grid__footer">
            <div className="card-grid__meta">{/* MCPs have no version / dep count */}</div>
            <button
              type="button"
              className="card-grid__action"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(m.name);
              }}
              aria-label={`Remove ${m.name}`}
              title={`Remove ${m.name}`}
            >
              <TrashIcon />
              <span>Remove</span>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
