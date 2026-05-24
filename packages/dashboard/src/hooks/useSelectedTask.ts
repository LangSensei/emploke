import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * Selected task id, stored as pure component state.
 *
 * Earlier iterations coupled this to the URL (`/tasks/:taskId` path segment),
 * but the agent-centric UI restructure (#agent-centric-ui §5) removed that:
 * task selection is ephemeral — refresh-preservation is intentionally NOT a
 * goal, and the row to re-select on remount is decided by the auto-select-
 * first-visible rule in `TasksPage` instead. Keeping the hook keeps callers
 * tidy and gives us a place to revisit the decision in one spot.
 *
 * The hook also reads a `preselectId` off `location.state` once on mount.
 * The Overview tab uses this to navigate into the Tasks tab with a specific
 * row highlighted (review round 1 — overview rows used to be inert). After
 * consuming, the state entry is cleared via `navigate(..., { replace: true })`
 * so a browser-back to Overview followed by re-entry doesn't re-fire the
 * pre-selection.
 */
export function useSelectedTask(): {
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
} {
  const location = useLocation();
  const navigate = useNavigate();
  const initial =
    typeof location.state === "object" && location.state !== null
      ? (((location.state as { preselectId?: unknown }).preselectId as string | undefined) ?? null)
      : null;
  const [selectedId, setSelectedId] = useState<string | null>(initial);

  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot on mount; navigate/location read intentionally only on first render
  useEffect(() => {
    if (initial === null) return;
    // Consume the preselect once: swap it out of history.state but keep
    // the same pathname so back-navigation lands where the user expects.
    navigate(location.pathname + location.search, { replace: true, state: null });
  }, []);

  return { selectedId, setSelectedId };
}
