/**
 * Public types for `@emploke/workspace`.
 *
 * Wire DTOs (returned by the service) and option-bag shapes live
 * here. The internal Drizzle row type lives in `schema.ts` and the
 * pkg-owned domain shape lives in `workspace-entity.ts` — neither is
 * exported from this barrel.
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
