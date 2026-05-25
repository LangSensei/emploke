import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * Marker dropped on `location.state` by the legacy-URL `<Navigate>`
 * adapter (App.tsx → `LegacyRuntimeRedirect`) so the destination page
 * can render a one-shot "moved" banner.
 */
export type LegacyMovedFrom = "sessions" | "tasks";

interface LegacyMovedBannerProps {
  /**
   * Which of the new pages this banner is hosted on; controls the
   * copy and the matching state-marker value.
   */
  page: LegacyMovedFrom;
}

/**
 * One-shot banner rendered on the new global `/runtime/sessions` and
 * `/runtime/tasks` pages when the user landed there via a permanent
 * redirect from the legacy top-level `/sessions` or `/tasks` URLs
 * (PR #189 polish Block C → Phase 1.5 Block F).
 *
 * The legacy redirect (`LegacyRuntimeRedirect` in App.tsx) drops a
 * `{from: 'sessions' | 'tasks'}` marker on `location.state` when
 * issuing the Navigate. This component:
 *   1. reads the marker once on mount,
 *   2. clears `history.state` so a browser-back into the redirect
 *      followed by re-entry doesn't re-fire the banner, and
 *   3. lets the user dismiss it explicitly.
 *
 * The banner only renders when the marker matches the hosting page
 * (i.e. `page === state.from`), so dropping the banner host on a page
 * the redirect doesn't target is a no-op.
 */
export function LegacyMovedBanner({ page }: LegacyMovedBannerProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const initial = readLegacyFrom(location.state) === page;
  const [visible, setVisible] = useState(initial);

  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot on mount; navigate/location read intentionally only on first render
  useEffect(() => {
    if (!initial) return;
    navigate(location.pathname + location.search, { replace: true, state: null });
  }, []);

  if (!visible) return null;

  const label = page === "sessions" ? "Sessions" : "Tasks";
  return (
    <aside className="legacy-url-banner" role="status" data-testid="legacy-url-banner">
      <span className="legacy-url-banner__body">
        We moved {label} to{" "}
        <strong>
          Runtime <span aria-hidden="true">→</span> {label}
        </strong>
        .
      </span>
      <button
        type="button"
        className="legacy-url-banner__dismiss"
        onClick={() => setVisible(false)}
        aria-label="Dismiss notice"
      >
        ✕
      </button>
    </aside>
  );
}

function readLegacyFrom(state: unknown): LegacyMovedFrom | null {
  if (typeof state !== "object" || state === null) return null;
  const candidate = (state as { from?: unknown }).from;
  return candidate === "sessions" || candidate === "tasks" ? candidate : null;
}
