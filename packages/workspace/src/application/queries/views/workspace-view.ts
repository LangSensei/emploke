/**
 * Read view: full workspace record. Stable JSON shape consumed by the
 * dashboard's workspace detail page and the CLI's `workspace show`
 * command.
 *
 * Per naming-conventions §3 — declared as TS `interface` because
 * ViewModels are pure data shapes with no behavior and no DI.
 */
export interface WorkspaceView {
  readonly id: string;
  readonly workspaceDir: string;
  readonly name: string;
  readonly createdAt: string;
  /** ISO-8601 timestamp; `null` when the workspace has never been opened. */
  readonly lastOpenedAt: string | null;
}
