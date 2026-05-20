/**
 * Read view: workspace summary for list endpoints. Today identical to
 * the legacy list-element shape (id + name + workspaceDir + createdAt)
 * — the dashboard's left rail and the CLI's `workspace list` both
 * render every column, so dropping any would be a UX regression.
 * Kept as a separate type from {@link WorkspaceView} so future
 * list-side trimming (e.g. dropping `createdAt` from the rail) doesn't
 * change the detail-view contract.
 */
export interface WorkspaceSummaryView {
  readonly id: string;
  readonly name: string;
  readonly workspaceDir: string;
  readonly createdAt: string;
}
