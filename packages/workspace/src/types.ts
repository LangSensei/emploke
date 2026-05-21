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
  readonly lastOpenedAt: string;
}
