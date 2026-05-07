/**
 * @emploke/sessions — per-session workdir registry.
 *
 * Sessions live at `~/.emploke/sessions/<id>/` (configurable). Each is a
 * provisioned workdir for one agent, plus a `.emploke/session.json` marker.
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
  SessionMarker,
  SessionRecord,
  SessionsManagerConfig,
} from "./types.js";
