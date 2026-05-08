interface TopBarProps {
  title: string;
  crumb?: string;
}

/**
 * TopBar is the per-page heading. Workspace selection lives in the Sidebar
 * (Linear-style) so the user always sees which workspace is active right
 * next to the navigation that's scoped to it.
 */
export function TopBar({ title, crumb }: TopBarProps) {
  return (
    <header className="topbar">
      <div>
        <h1 className="topbar__title">{title}</h1>
        {crumb && <div className="topbar__crumb">{crumb}</div>}
      </div>
    </header>
  );
}
