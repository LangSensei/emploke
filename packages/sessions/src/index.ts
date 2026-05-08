/**
 * @emploke/sessions — per-session workdir registry.
 *
 * Sessions live at `~/.emploke/sessions/<id>/` (configurable). Each is a
 * provisioned workdir for one agent. The agent name is read from the
 * provisioned `AGENTS.md` frontmatter; createdAt comes from `fs.stat`.
 * The package never spawns processes — it returns launch incantations for
 * callers to exec.
 *
 * See the package README for usage and design rationale.
 */

export {
  AgentNotFoundError,
  CopilotSessionNotFoundError,
  CopilotStateDeletionFailed,
  InvalidCopilotSessionIdError,
  InvalidSessionIdError,
  SessionAlreadyExistsError,
  SessionNotFoundError,
  SessionsError,
} from "./errors.js";
export { SessionsManager } from "./manager.js";
export type {
  CopilotSessionInfo,
  CreateSessionOpts,
  DeleteSessionOpts,
  LaunchCommand,
  ListSessionOpts,
  Logger,
  SessionRecord,
  SessionsManagerConfig,
} from "./types.js";
