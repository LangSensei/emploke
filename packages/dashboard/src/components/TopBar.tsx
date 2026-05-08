import type { WorkspaceListItem } from "../api";

interface TopBarProps {
  title: string;
  crumb?: string;
  workspaces: WorkspaceListItem[];
  currentWorkspace: string | null;
  onSelectWorkspace: (name: string) => void;
  onAddWorkspace: () => void;
}

const ADD_OPTION = "__add__";

export function TopBar({
  title,
  crumb,
  workspaces,
  currentWorkspace,
  onSelectWorkspace,
  onAddWorkspace,
}: TopBarProps) {
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (value === ADD_OPTION) {
      onAddWorkspace();
      return;
    }
    onSelectWorkspace(value);
  };

  // If the persisted current workspace isn't in the registry yet (e.g.
  // server hasn't responded, or the workspace was removed elsewhere),
  // fall back to "(none)" rather than confusingly showing a stale name.
  const selectedExists = workspaces.some((w) => w.name === currentWorkspace);
  const selectValue = selectedExists ? (currentWorkspace ?? "") : "";

  return (
    <header className="topbar">
      <div>
        <h1 className="topbar__title">{title}</h1>
        {crumb && <div className="topbar__crumb">{crumb}</div>}
      </div>
      <div className="topbar__spacer" />
      <label className="topbar__workspace">
        <span className="topbar__workspace-label">Workspace</span>
        <select
          className="topbar__workspace-select"
          value={selectValue}
          onChange={handleChange}
          aria-label="Select workspace"
        >
          {workspaces.length === 0 && <option value="">(none)</option>}
          {!selectedExists && currentWorkspace !== null && workspaces.length > 0 && (
            <option value="">(select a workspace)</option>
          )}
          {workspaces.map((w) => (
            <option key={w.name} value={w.name}>
              {w.name}
              {w.status !== "ok" ? ` — ${w.status}` : ""}
            </option>
          ))}
          <option value={ADD_OPTION}>+ Add workspace…</option>
        </select>
      </label>
    </header>
  );
}
