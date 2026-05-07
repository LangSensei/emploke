interface TopBarProps {
  title: string;
  crumb?: string;
}

export function TopBar({ title, crumb }: TopBarProps) {
  return (
    <header className="topbar">
      <div>
        <h1 className="topbar__title">{title}</h1>
        {crumb && <div className="topbar__crumb">{crumb}</div>}
      </div>
      <div className="topbar__spacer" />
      {/* Future: search, notifications, workspace switcher. Page-level
          actions belong inside their own page header, not here. */}
    </header>
  );
}
