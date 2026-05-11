/**
 * @emploke/session — per-session workdir manager.
 *
 * Each session is a provisioned workdir for one agent under one runtime
 * (e.g. copilot, gemini). The agent name is read from the provisioned
 * `AGENTS.md` frontmatter; runtime + createdAt + runtimeSessionId are
 * persisted via the configured `SessionRepository` (defaults to
 * `FsSessionRepository`, which writes `<workdir>/session.json`).
 * Activity (lastActiveAt, preview) is read fresh from the runtime on
 * every list/get call. The package never spawns processes —
 * `buildLaunch()` returns a shell-runnable `LaunchCommand`.
 */

// Re-export runtime errors that callers commonly want to catch alongside
// session errors.
export {
  RuntimeDoesNotSupportRemoteError,
  RuntimeProvisionFailed,
  RuntimeRefreshFailed,
  RuntimeStateDeletionFailed,
  TrustRegistrationFailed,
  UnknownRuntimeError,
} from "@emploke/runtime";
export {
  AgentNotFoundError,
  InvalidSessionIdError,
  SessionCorruptedError,
  SessionIdAllocationFailedError,
  SessionNotFoundError,
  SessionsError,
} from "./errors.js";
export { SessionManager } from "./manager.js";
export { FsSessionRepository } from "./repositories/fs-session-repository.js";
export type {
  ListSessionStateOpts,
  SessionRepository,
  SessionState,
} from "./repositories/repository.js";
export type {
  BuildLaunchSessionOpts,
  CreateSessionOpts,
  DeleteSessionOpts,
  LaunchCommand,
  ListSessionOpts,
  Logger,
  ManagedSession,
  Session,
  SessionManagerConfig,
  SessionRecord,
} from "./types.js";
