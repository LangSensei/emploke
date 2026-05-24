interface TopBarProps {
  title: string;
  /**
   * Breadcrumb chain rendered below the title. Each segment is plain text;
   * segments are never wrapped in <Link>. When the chain is omitted or
   * empty, no breadcrumb row renders.
   *
   * For pages with a single legacy crumb, pass a one-element array so the
   * existing layout (small muted line under the H1) is preserved.
   */
  breadcrumb?: readonly string[];
  /**
   * Ref callback wired to the trailing actions container. Pages portal
   * their toolbars into it through `HeaderActionsContext` so the chrome
   * header doubles as the page action strip.
   */
  actionsRef?: (el: HTMLDivElement | null) => void;
}

/**
 * TopBar is the per-page heading. Workspace selection lives in the Sidebar
 * (Linear-style) so the user always sees which workspace is active right
 * next to the navigation that's scoped to it. The trailing `topbar__actions`
 * slot is a portal target — pages (e.g. Catalog) inject their primary
 * actions via `<HeaderActions>`.
 *
 * The breadcrumb is text only by design (#agent-centric-ui §6): clickable
 * crumbs are explicitly out of scope for the v1 restructure.
 */
export function TopBar({ title, breadcrumb, actionsRef }: TopBarProps) {
  const chain = breadcrumb && breadcrumb.length > 0 ? breadcrumb : null;
  return (
    <header className="topbar">
      <div>
        <h1 className="topbar__title">{title}</h1>
        {chain && <div className="topbar__crumb">{chain.join(" / ")}</div>}
      </div>
      <div className="topbar__spacer" />
      <div className="topbar__actions" ref={actionsRef} />
    </header>
  );
}
