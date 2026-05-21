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
  AgentNotFoundError,
  InvalidSessionIdError,
  SessionCorruptedError,
  SessionIdAllocationFailedError,
  SessionNotFoundError,
  SessionError,
} from "./errors.js";

export { type Session, type NewSession, sessions } from "./schema.js";
export { SessionRepository, type ListSessionStateOpts } from "./repository.js";
export { SessionManager } from "./manager.js";
export {
  composeSessionModule,
  type SessionModule,
  type SessionModuleOptions,
} from "./compose.js";
export type {
  BuildInteractiveLaunchSessionOpts,
  CreateSessionOpts,
  DeleteSessionOpts,
  LaunchCommand,
  ListSessionOpts,
  SessionManagerConfig,
  SessionView,
} from "./types.js";
