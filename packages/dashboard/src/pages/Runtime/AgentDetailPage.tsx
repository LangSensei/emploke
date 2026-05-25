import { Navigate, useLocation, useParams } from "react-router-dom";

/**
 * PR #189 polish v2 — the per-agent detail moved into the master Agents
 * page as a master-detail right pane (selection via `?selected=<scope>/<short>`).
 * This component used to render the standalone detail view; it now exists
 * purely as a backward-compatibility redirect for external bookmarks and
 * PR-description links that pre-date the master-detail restructure.
 *
 * The legacy routes are:
 *   /workspaces/<wsId>/runtime/agents/:scope/:short          (index)
 *   /workspaces/<wsId>/runtime/agents/:scope/:short/overview (overview tab)
 *
 * Both collapse here and redirect to
 *   /workspaces/<wsId>/runtime/agents?selected=<scope>/<short>
 *
 * Any other querystring the bookmark carried (e.g. `?ref=link`) is
 * preserved verbatim by merging it into the destination's search params
 * alongside the new `selected=` value — the master Agents page reads its
 * own filter slots (`?filter=`, `?q=`) the same way Tasks does and is
 * tolerant of unknown params.
 *
 * No breadcrumb push lives here any more; the master Agents page sets
 * the breadcrumb to `Runtime / Agents` and keeps it there regardless of
 * the selected agent.
 */
export function AgentDetailPage() {
  const { wsId, scope, short } = useParams<{
    wsId: string;
    scope: string;
    short: string;
  }>();
  const location = useLocation();
  if (!wsId) return <Navigate to="/" replace />;
  if (!scope || !short) {
    return (
      <Navigate
        to={`/workspaces/${encodeURIComponent(wsId)}/runtime/agents${location.search}`}
        replace
      />
    );
  }
  const fqn = `${scope}/${short}`;
  // Preserve any pre-existing querystring the legacy bookmark carried,
  // overlaying `selected=<fqn>` so the redirect target opens with the
  // agent pre-selected. URLSearchParams.set replaces any prior value of
  // the same key (defensive — the legacy URL shouldn't carry one, but a
  // copy-pasted link from the new shape into the old shape might).
  const incoming = new URLSearchParams(location.search);
  incoming.set("selected", fqn);
  return (
    <Navigate
      to={{
        pathname: `/workspaces/${encodeURIComponent(wsId)}/runtime/agents`,
        search: `?${incoming.toString()}`,
      }}
      replace
    />
  );
}
