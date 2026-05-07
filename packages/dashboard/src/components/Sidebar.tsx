import type { ReactElement } from "react";
import { CatalogIcon, HomeIcon, SessionsIcon, SettingsIcon, SubstratesIcon } from "./Icons";

export type SectionId = "overview" | "catalog" | "sessions" | "substrates" | "settings";

export interface SectionDef {
  id: SectionId;
  label: string;
  badge?: string;
  disabled?: boolean;
}

const ICONS: Record<SectionId, (props: { className?: string }) => ReactElement> = {
  overview: HomeIcon,
  catalog: CatalogIcon,
  sessions: SessionsIcon,
  substrates: SubstratesIcon,
  settings: SettingsIcon,
};

interface SidebarProps {
  sections: SectionDef[];
  active: SectionId;
  onSelect: (id: SectionId) => void;
}

export function Sidebar({ sections, active, onSelect }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__brand-mark">E</span>
        <span>Emploke</span>
      </div>

      <nav className="sidebar__nav">
        <div className="sidebar__group-label">Workspace</div>
        {sections.map((s) => {
          const Icon = ICONS[s.id];
          return (
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
              <span className="sidebar__icon">
                <Icon />
              </span>
              <span>{s.label}</span>
              {s.badge && <span className="sidebar__badge">{s.badge}</span>}
            </button>
          );
        })}
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
