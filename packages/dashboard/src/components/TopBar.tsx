interface TopBarProps {
  title: string;
  crumb?: string;
  /**
   * Ref callback wired to the trailing actions container. Pages portal
   * their toolbars into it through `HeaderActionsContext` so the chrome
   * header doubles as the page action strip (no separate `.page-toolbar`
   * row needed).
   */
  actionsRef?: (el: HTMLDivElement | null) => void;
}

/**
 * TopBar is the per-page heading. Workspace selection lives in the Sidebar
 * (Linear-style) so the user always sees which workspace is active right
 * next to the navigation that's scoped to it. The trailing `topbar__actions`
 * slot is a portal target — pages (e.g. Tasks) inject their Refresh / Dispatch
 * buttons via `<HeaderActions>`.
 */
export function TopBar({ title, crumb, actionsRef }: TopBarProps) {
  return (
    <header className="topbar">
      <div>
        <h1 className="topbar__title">{title}</h1>
        {crumb && <div className="topbar__crumb">{crumb}</div>}
      </div>
      <div className="topbar__spacer" />
      <div className="topbar__actions" ref={actionsRef} />
    </header>
  );
}
