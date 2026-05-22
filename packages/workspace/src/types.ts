/**
 * Public types for `@emploke/workspace`.
 *
 * All public DTOs and option shapes live here per the
 * architecture-design Section 11 convention.
 */

/** Wire-shape DTO returned by `WorkspaceService` reads. */
export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly workspaceDir: string;
  readonly createdAt: string;
  /**
   * Always populated on the DTO. The underlying schema column is
   * nullable (a freshly-registered workspace may not have been
   * opened yet), but `WorkspaceService.get*` calls coalesce
   * `lastOpenedAt ?? createdAt` so consumers never see `null`.
   * Format: ISO-8601 UTC string (e.g. `2026-05-22T08:14:00.000Z`).
   */
  readonly lastOpenedAt: string;
}
