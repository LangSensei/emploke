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
  RuntimeIcon,
  SessionsIcon,
  SettingsIcon,
  TasksIcon,
} from "./Icons";

export type SectionId = "overview" | "runtime" | "catalog" | "settings";

/**
 * Runtime children promoted under the Runtime group header per Phase 1.5
 * §4.1: Agents (existing default landing) plus Sessions and Tasks which
 * used to be either top-level items (legacy) or per-agent sub-tabs
 * (PR #189). They share the workspace-scoped path prefix
 * `/runtime/<child>` so the highlight selector can match on the segment
 * after the section.
 */
export type RuntimeChildId = "agents" | "sessions" | "tasks";

/**
 * Full identity of a clickable sidebar item. A `SectionId` selects a
 * top-level section; `runtime:<child>` selects one of Runtime's three
 * children. The compound form keeps the section / sub-section invariant
 * out of `App.tsx` (the renderer derives both halves from one id).
 */
export type SidebarItemId = SectionId | `runtime:${RuntimeChildId}`;

export interface SectionDef {
  id: SectionId;
  label: string;
  badge?: string;
  disabled?: boolean;
  /**
   * Nested items rendered indented under the section. Per §4.1 only
   * Runtime carries children today (Agents / Sessions / Tasks).
   */
  children?: ReadonlyArray<RuntimeChildDef>;
}

export interface RuntimeChildDef {
  id: RuntimeChildId;
  label: string;
}

const ICONS: Record<SectionId, (props: { className?: string }) => ReactElement> = {
  overview: HomeIcon,
  runtime: RuntimeIcon,
  catalog: CatalogIcon,
  settings: SettingsIcon,
};

const CHILD_ICONS: Record<RuntimeChildId, (props: { className?: string }) => ReactElement> = {
  agents: RuntimeIcon,
  sessions: SessionsIcon,
  tasks: TasksIcon,
};

const ADD_OPTION = "__add__";

interface SidebarProps {
  sections: SectionDef[];
  /**
   * Currently-selected item — either a top-level section id or a
   * compound `runtime:<child>` id. Drives the highlight state for
   * both the section button and the nested child rows.
   */
  active: SidebarItemId;
  /**
   * Called with a top-level section id when the user clicks a
   * Sidebar row at the section level (Overview, Catalog, Settings)
   * or the Runtime parent header.
   */
  onSelect: (id: SectionId) => void;
  /**
   * Called with the Runtime child id when the user clicks one of the
   * nested Agents / Sessions / Tasks rows. Routed to the matching
   * `/workspaces/<wsId>/runtime/<child>` URL by the caller.
   */
  onSelectRuntimeChild: (id: RuntimeChildId) => void;
  workspaces: WorkspaceListItem[];
  /** UUID of the workspace currently in scope (from the URL), or null. */
  currentWorkspaceId: string | null;
  /** Called with the UUID of the workspace the user picked. */
  onSelectWorkspace: (id: string) => void;
  onAddWorkspace: () => void;
  /**
   * Persist a new display name for the currently-selected workspace.
   * Only the metadata `name` (workspace row in `global.db`) changes — the registry id
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
  onSelectRuntimeChild,
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
  // populated even when the workspace metadata row is unreadable, so the user can
  // navigate to settings and fix it.
  const displayName = currentEntry?.name ?? currentWorkspaceId ?? "";

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
                  const label = w.name ?? w.id;
                  return (
                    <option key={w.id} value={w.id}>
                      {label}
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
          // Section is "active" iff the active id refers to it (either
          // the top-level section, or — for Runtime — any of its
          // children). Used to render the parent header as expanded /
          // visually grouped rather than the underlying button highlight
          // (which goes to the child row when one is active).
          const sectionMatches =
            active === s.id ||
            (s.id === "runtime" && typeof active === "string" && active.startsWith("runtime:"));
          // Only highlight the parent button when the section itself
          // is the active id (no child selected). When a child is
          // active the highlight moves to the child row.
          const highlightParent = active === s.id;
          return (
            <div key={s.id} className="sidebar__group">
              <button
                type="button"
                disabled={s.disabled}
                onClick={() => !s.disabled && onSelect(s.id)}
                className={[
                  "sidebar__item",
                  highlightParent ? "sidebar__item--active" : "",
                  s.disabled ? "sidebar__item--disabled" : "",
                  s.children && s.children.length > 0 ? "sidebar__item--parent" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                title={s.disabled ? "Coming soon" : undefined}
                aria-expanded={s.children && s.children.length > 0 ? sectionMatches : undefined}
              >
                <span className="sidebar__icon">
                  <Icon />
                </span>
                <span>{s.label}</span>
                {s.badge && <span className="sidebar__badge">{s.badge}</span>}
              </button>
              {s.children && s.children.length > 0 && (
                <ul className="sidebar__children" aria-label={`${s.label} sub-navigation`}>
                  {s.children.map((c) => {
                    const ChildIcon = CHILD_ICONS[c.id];
                    const childActive = active === `runtime:${c.id}`;
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => onSelectRuntimeChild(c.id)}
                          className={[
                            "sidebar__item",
                            "sidebar__item--child",
                            childActive ? "sidebar__item--active" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          aria-current={childActive ? "page" : undefined}
                        >
                          <span className="sidebar__icon sidebar__icon--child">
                            <ChildIcon />
                          </span>
                          <span>{c.label}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
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
