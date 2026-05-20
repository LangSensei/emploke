/**
 * Read view: workspace summary for list endpoints (id + name +
 * workspaceDir + createdAt). The dashboard's left rail and the
 * CLI's `workspace list` both render every column, so dropping any
 * would be a UX regression. Kept as a separate type from
 * {@link WorkspaceView} so future list-side trimming (e.g. dropping
 * `createdAt` from the rail) doesn't change the detail-view contract.
 */
export interface WorkspaceSummaryView {
  readonly id: string;
  readonly name: string;
  readonly workspaceDir: string;
  readonly createdAt: string;
  /** ISO-8601 timestamp; `null` when the workspace has never been opened. */
  readonly lastOpenedAt: string | null;
}
