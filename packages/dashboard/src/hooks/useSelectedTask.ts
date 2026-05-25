import { useCallback, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useUrlSearchValue } from "./useUrlState";

/**
 * Selected task id, mirrored to the URL via `?taskId=` so refresh /
 * back-button / share-link all land the user on the same master-detail
 * row (Phase 1.5 §4.6 / Block G — URL-driven filters).
 *
 * Backward compatibility for the agent-Overview deep-link affordance:
 * older `location.state.preselectId` payloads (set by `AgentOverviewTab`
 * before Phase 1.5) are consumed once on mount and translated into
 * the URL slot, then cleared. Preserves the "click a recent task in
 * the agent overview to land on it pre-selected" behaviour without
 * forcing the Overview tab to know about the URL convention.
 */
export function useSelectedTask(): {
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
} {
  const [urlValue, setUrlValue] = useUrlSearchValue("taskId", "");
  const location = useLocation();
  const navigate = useNavigate();

  const selectedId = urlValue === "" ? null : urlValue;
  const setSelectedId = useCallback(
    (id: string | null) => {
      setUrlValue(id ?? "");
    },
    [setUrlValue],
  );

  // One-shot translation of the legacy `location.state.preselectId`
  // payload (from AgentOverviewTab pre-Phase-1.5) into the URL slot.
  // After consuming we clear `history.state` so a browser-back into
  // the agent Overview followed by re-entry doesn't re-fire it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot on mount; intentionally reads navigate/location only once
  useEffect(() => {
    const stateId = readPreselectId(location.state);
    if (stateId === null) return;
    setUrlValue(stateId);
    navigate(location.pathname + location.search, { replace: true, state: null });
  }, []);

  return { selectedId, setSelectedId };
}

function readPreselectId(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const candidate = (state as { preselectId?: unknown }).preselectId;
  return typeof candidate === "string" && candidate !== "" ? candidate : null;
}
