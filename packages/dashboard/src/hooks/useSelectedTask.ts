import { useState } from "react";

/**
 * Selected task id, stored as pure component state.
 *
 * Earlier iterations coupled this to the URL (`/tasks/:taskId` path segment),
 * but the agent-centric UI restructure (#agent-centric-ui §5) removed that:
 * task selection is ephemeral — refresh-preservation is intentionally NOT a
 * goal, and the row to re-select on remount is decided by the auto-select-
 * first-visible rule in `TasksPage` instead. Keeping the hook keeps callers
 * tidy and gives us a place to revisit the decision in one spot.
 */
export function useSelectedTask(): {
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
} {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return { selectedId, setSelectedId };
}
