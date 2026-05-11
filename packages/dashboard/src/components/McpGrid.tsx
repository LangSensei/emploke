import type { McpItem } from "../api";
import { TrashIcon } from "./Icons";

interface McpGridProps {
  mcps: McpItem[];
  onEdit: (name: string) => void;
  onRemove: (name: string) => void;
}

/**
 * Renders the same shell as `EntryGrid` (so MCP cards line up visually
 * with skill/agent cards) but leaves description and meta empty —
 * MCPs have no version, no deps, and the JSON config is best inspected
 * by clicking the card. The right-hand "ready" badge mirrors
 * skill/agent's status badge; MCPs are always ready since they have
 * no resolvable dependencies.
 */
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
          title={m.mutable ? `Click to edit ${m.name}` : `Click to view ${m.name} (read-only)`}
        >
          <div className="card-grid__top">
            <span className="card-grid__name" title={m.name}>
              {m.name}
            </span>
            <span className="badge badge--ready">✓ ready</span>
          </div>
          {/* Description and footer-meta intentionally empty — MCPs
              carry no description / version / dep count. Keeping the
              empty placeholder elements preserves the same vertical
              rhythm as skill/agent cards so the grid reads uniformly. */}
          <p className="card-grid__desc" />
          <div className="card-grid__footer">
            <div className="card-grid__meta" />
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
