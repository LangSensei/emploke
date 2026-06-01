import type { WorkspaceListItem } from "../../api/index.js";

/**
 * Hand-authored workspace fixtures. The first entry's id is the one the
 * server's `/api/workspaces/current` mock returns, so it's the workspace
 * the dashboard auto-routes to on cold load.
 */
export const fixtureWorkspaces: WorkspaceListItem[] = [
  {
    id: "ws-mock-primary",
    name: "Designer workspace",
    createdAt: "2026-05-20T08:00:00.000Z",
    workspaceDir: "/mock/workspaces/designer",
  },
  {
    id: "ws-mock-secondary",
    name: "Spare workspace",
    createdAt: "2026-05-15T09:30:00.000Z",
    workspaceDir: "/mock/workspaces/spare",
  },
];

/** Default active workspace — used by `/api/workspaces/current` and as the URL fallback. */
export const fixtureActiveWorkspaceId = fixtureWorkspaces[0]!.id;
