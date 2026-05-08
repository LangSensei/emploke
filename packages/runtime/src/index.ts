// Public surface for @emploke/runtime.

export type { CopilotRuntimeConfig } from "./copilot/copilot.js";
// Copilot runtime
export { CopilotRuntime } from "./copilot/copilot.js";
export {
  InvalidMcpJson,
  TrustRegistrationFailed,
  WorkdirPrepFailed,
} from "./copilot/errors.js";
export {
  COPILOT_SESSION_ID_RE,
  generateCopilotSessionId,
  isCopilotSessionId,
} from "./copilot/ids.js";
export { flattenSkillName } from "./copilot/provision.js";
export { isPathCovered } from "./copilot/trust.js";
export {
  RuntimeProvisionFailed,
  RuntimeRefreshFailed,
  RuntimeRegisterWorkspaceFailed,
  RuntimeStateDeletionFailed,
  UnknownRuntimeError,
} from "./errors.js";
export { RuntimeRegistry } from "./registry.js";
export type { LaunchCommand, Runtime, Session } from "./types.js";
