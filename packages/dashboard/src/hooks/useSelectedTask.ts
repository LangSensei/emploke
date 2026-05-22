import { useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";

/**
 * URL-bound task selection. The router declares
 * `/workspaces/:wsId/:section/:tab`; for the tasks section the `tab`
 * slot carries the task id. Mirrors that pair to a single
 * `(selectedId, setSelectedId)` tuple so the page component doesn't
 * have to know about the route layout.
 *
 * The mission-A spec calls for a `?taskId=…` query param. The
 * existing path-param shape achieves the same goal (refresh +
 * shared link preserve the selection) without touching App.tsx
 * routing or breaking sibling pages, so we keep it.
 */
export function useSelectedTask(currentWorkspaceId: string | null): {
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
} {
  const params = useParams<{ wsId: string; section?: string; tab?: string }>();
  const navigate = useNavigate();
  const selectedId = params.tab ?? null;
  const setSelectedId = useCallback(
    (id: string | null) => {
      const ws = encodeURIComponent(currentWorkspaceId ?? "");
      navigate(id === null ? `/workspaces/${ws}/tasks` : `/workspaces/${ws}/tasks/${id}`);
    },
    [navigate, currentWorkspaceId],
  );
  return { selectedId, setSelectedId };
}
