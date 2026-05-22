/**
 * Domain entity for `@emploke/session`. Pkg-owned plain interface
 * representing the **persisted slice** of a session.
 *
 * Layer position:
 *   - `SessionRow` (schema.ts)          — Drizzle ORM shape; private
 *   - `SessionEntity` (this file)       — pkg-owned domain shape;
 *                                          what `SessionRepository`
 *                                          returns. Mirrors the
 *                                          persisted columns.
 *   - `Session` (types.ts)              — wire DTO; what
 *                                          `SessionService` returns.
 *                                          A composite of this entity
 *                                          + `workdir` (computed
 *                                          from layout) + live
 *                                          `lastActiveAt` / `preview`
 *                                          (read fresh from the
 *                                          runtime on every read).
 *
 * Not re-exported from `index.ts`: external consumers see only the
 * `Session` DTO. The entity is the contract between the repository
 * and the service inside this pkg.
 *
 * No class wrapper: session has no state machine. The status-like
 * fields (`runtimeSessionId`, `lastLaunchMode`) move via dedicated
 * service methods (`buildInteractiveLaunch`, `patchLastLaunchMode`),
 * not via entity-instance methods.
 */
export interface SessionEntity {
  readonly id: string;
  readonly agent: string;
  readonly runtime: string;
  readonly createdAt: string;
  readonly runtimeSessionId: string | null;
  readonly lastLaunchMode: "local" | "remote" | null;
}
