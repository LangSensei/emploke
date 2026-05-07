export type SectionId = "overview" | "catalog" | "sessions" | "substrates" | "settings";

export interface SectionDef {
  id: SectionId;
  label: string;
  icon: string;
  badge?: string;
  disabled?: boolean;
}

interface SidebarProps {
  sections: SectionDef[];
  active: SectionId;
  onSelect: (id: SectionId) => void;
}

export function Sidebar({ sections, active, onSelect }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="emoji">🔮</span>
        <span>Emploke</span>
      </div>

      <nav className="sidebar__nav">
        <div className="sidebar__group-label">Workspace</div>
        {sections.map((s) => (
          <button
            type="button"
            key={s.id}
            disabled={s.disabled}
            onClick={() => !s.disabled && onSelect(s.id)}
            className={[
              "sidebar__item",
              active === s.id ? "sidebar__item--active" : "",
              s.disabled ? "sidebar__item--disabled" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            title={s.disabled ? "Coming soon" : undefined}
          >
            <span className="sidebar__icon">{s.icon}</span>
            <span>{s.label}</span>
            {s.badge && <span className="sidebar__badge">{s.badge}</span>}
          </button>
        ))}
      </nav>

      <div className="sidebar__footer">
        <div>
          <code>@emploke/dashboard</code>
        </div>
        <div style={{ marginTop: 4 }}>v0.0.1</div>
      </div>
    </aside>
  );
}
