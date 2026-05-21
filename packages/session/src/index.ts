/**
 * @emploke/session — per-session workdir manager.
 *
 * Each session is a provisioned workdir for one agent under one runtime
 * (e.g. copilot, gemini). Persistence is backed by MikroORM via a
 * per-workspace `workspace.db`. Activity (lastActiveAt, preview) is
 * read fresh from the runtime on every list/get call.
 *
 * The package never spawns processes — `buildInteractiveLaunch()`
 * returns a shell-runnable `LaunchCommand`.
 */

// Re-export runtime errors callers commonly want to catch alongside session errors.
export {
  RuntimeDoesNotSupportRemoteError,
  RuntimeProvisionFailed,
  RuntimeRefreshFailed,
  RuntimeStateDeletionFailed,
  TrustRegistrationFailed,
  UnknownRuntimeError,
} from "@emploke/runtime";
export {
  composeSessionModule,
  type SessionModule,
  type SessionModuleOptions,
} from "./compose.js";
export {
  AgentNotFoundError,
  InvalidSessionIdError,
  SessionCorruptedError,
  SessionError,
  SessionIdAllocationFailedError,
  SessionNotFoundError,
} from "./errors.js";
export { SessionManager } from "./manager.js";
export { type ListSessionStateOpts, SessionRepository } from "./repository.js";
export { type NewSession, type Session, sessions } from "./schema.js";
export type {
  BuildInteractiveLaunchSessionOpts,
  CreateSessionOpts,
  DeleteSessionOpts,
  LaunchCommand,
  ListSessionOpts,
  SessionManagerConfig,
  SessionView,
} from "./types.js";
