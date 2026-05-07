interface TopBarProps {
  title: string;
  crumb?: string;
  onRefresh: () => void;
  refreshing?: boolean;
}

export function TopBar({ title, crumb, onRefresh, refreshing }: TopBarProps) {
  return (
    <header className="topbar">
      <div>
        <h1 className="topbar__title">{title}</h1>
        {crumb && <div className="topbar__crumb">{crumb}</div>}
      </div>
      <div className="topbar__spacer" />
      <div className="topbar__actions">
        <button type="button" className="btn" onClick={onRefresh} disabled={refreshing}>
          <span>{refreshing ? "⟳" : "↻"}</span>
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>
    </header>
  );
}
