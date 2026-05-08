/**
 * @emploke/session — per-session workdir registry.
 *
 * Sessions live at `~/.emploke/sessions/<id>/` (configurable). Each is a
 * provisioned workdir for one agent under one runtime (e.g. copilot,
 * gemini). The agent name is read from the provisioned `AGENTS.md`
 * frontmatter; runtime + createdAt + runtimeSessionId are persisted in
 * `<workdir>/session.json`. Activity (lastActiveAt, preview) is read fresh
 * from the runtime on every list/get call. The package never spawns
 * processes — `buildLaunch()` returns a shell-runnable `LaunchCommand`.
 */

// Re-export runtime errors that callers commonly want to catch alongside
// session errors.
export {
  RuntimeProvisionFailed,
  RuntimeRefreshFailed,
  RuntimeStateDeletionFailed,
  UnknownRuntimeError,
} from "@emploke/runtime";
export {
  AgentNotFoundError,
  InvalidSessionIdError,
  SessionAlreadyExistsError,
  SessionCorruptedError,
  SessionNotFoundError,
  SessionsError,
} from "./errors.js";
export {
  CURRENT_SCHEMA_VERSION,
  readPersistedSession,
  SESSION_FILE_NAME,
  SessionManager,
  writePersistedSession,
} from "./manager.js";
export type {
  CreateSessionOpts,
  DeleteSessionOpts,
  LaunchCommand,
  ListSessionOpts,
  Logger,
  ManagedSession,
  PersistedSession,
  Session,
  SessionManagerConfig,
  SessionRecord,
} from "./types.js";
