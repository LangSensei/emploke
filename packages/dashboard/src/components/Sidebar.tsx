import { type ReactElement, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { WorkspaceListItem } from "../api";
import {
  ArrowLeftIcon,
  CatalogIcon,
  CheckIcon,
  CloseIcon,
  HomeIcon,
  PencilIcon,
  SessionsIcon,
  SettingsIcon,
  SubstratesIcon,
  TasksIcon,
} from "./Icons";

export type SectionId = "overview" | "catalog" | "sessions" | "tasks" | "substrates" | "settings";

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
  tasks: TasksIcon,
  substrates: SubstratesIcon,
  settings: SettingsIcon,
};

const ADD_OPTION = "__add__";

interface SidebarProps {
  sections: SectionDef[];
  active: SectionId;
  onSelect: (id: SectionId) => void;
  workspaces: WorkspaceListItem[];
  /** UUID of the workspace currently in scope (from the URL), or null. */
  currentWorkspaceId: string | null;
  /** Called with the UUID of the workspace the user picked. */
  onSelectWorkspace: (id: string) => void;
  onAddWorkspace: () => void;
  /**
   * Persist a new display name for the currently-selected workspace.
   * Only the metadata `name` (workspace.json) changes  the registry id
   * and on-disk directory are intentionally untouched.
   */
  onRenameWorkspace: (id: string, newDisplayName: string) => Promise<void>;
}

/**
 * Top-of-sidebar workspace control. The workspace identity replaces the
 * old "Emploke" brand because every navigable section is workspace-scoped
 *  surfacing the project context at the very top of the navigation tree
 * keeps "which world am I in?" answerable at a glance, the way Linear and
 * Notion do for their workspace switchers.
 */
export function Sidebar({
  sections,
  active,
  onSelect,
  workspaces,
  currentWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace,
  onRenameWorkspace,
}: SidebarProps) {
  const selectedExists = workspaces.some((w) => w.id === currentWorkspaceId);
  const selectValue = selectedExists ? (currentWorkspaceId ?? "") : "";
  const currentEntry = workspaces.find((w) => w.id === currentWorkspaceId);
  // Falling back to the raw id is intentional: it keeps the dropdown
  // populated even when workspace.json is unreadable, so the user can
  // navigate to settings and fix it.
  const displayName = currentEntry?.metadata?.name ?? currentWorkspaceId ?? "";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus + select-all whenever rename mode opens, so the user can
  // start typing immediately or replace the whole name in one keystroke.
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleWorkspaceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (value === ADD_OPTION) {
      onAddWorkspace();
      return;
    }
    onSelectWorkspace(value);
  };

  const startEdit = () => {
    if (!currentWorkspaceId) return;
    setDraft(displayName);
    setError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setError(null);
  };

  const commitEdit = async () => {
    if (!currentWorkspaceId) return;
    const next = draft.trim();
    if (next === "" || next === displayName) {
      cancelEdit();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onRenameWorkspace(currentWorkspaceId, next);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar__header">
        {editing ? (
          <div className="sidebar__rename">
            <input
              ref={inputRef}
              type="text"
              className="sidebar__rename-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={saving}
              placeholder="Display name"
              aria-label="New workspace display name"
            />
            <button
              type="button"
              className="sidebar__icon-btn"
              onClick={() => void commitEdit()}
              disabled={saving}
              title="Save (Enter)"
              aria-label="Save"
            >
              <CheckIcon className="sidebar__icon-btn-svg" />
            </button>
            <button
              type="button"
              className="sidebar__icon-btn"
              onClick={cancelEdit}
              disabled={saving}
              title="Cancel (Esc)"
              aria-label="Cancel"
            >
              <CloseIcon className="sidebar__icon-btn-svg" />
            </button>
          </div>
        ) : (
          <div className="sidebar__switcher">
            <div className="sidebar__switcher-select-wrap">
              <select
                className="sidebar__switcher-select"
                value={selectValue}
                onChange={handleWorkspaceChange}
                aria-label="Select workspace"
              >
                {workspaces.length === 0 && <option value="">(no workspace)</option>}
                {!selectedExists && currentWorkspaceId !== null && workspaces.length > 0 && (
                  <option value="">(select)</option>
                )}
                {workspaces.map((w) => {
                  const label = w.metadata?.name ?? w.id;
                  const suffix = w.status !== "ok" ? `  ${w.status}` : "";
                  return (
                    <option key={w.id} value={w.id}>
                      {label}
                      {suffix}
                    </option>
                  );
                })}
                <option value={ADD_OPTION}>+ Add workspace</option>
              </select>
            </div>
            <button
              type="button"
              className="sidebar__icon-btn"
              onClick={startEdit}
              disabled={!currentWorkspaceId || !selectedExists}
              title="Rename workspace"
              aria-label="Rename workspace"
            >
              <PencilIcon className="sidebar__icon-btn-svg" />
            </button>
          </div>
        )}
        {error && <div className="sidebar__rename-error">{error}</div>}
      </div>

      <nav className="sidebar__nav">
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
        <Link to="/" className="sidebar__home-link" title="Back to all workspaces">
          <ArrowLeftIcon className="sidebar__home-link-icon" />
          <span>All workspaces</span>
        </Link>
      </div>
    </aside>
  );
}
