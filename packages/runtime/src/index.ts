// Public surface for @emploke/runtime.

export type { CopilotRuntimeConfig } from "./copilot/copilot.js";
// Copilot runtime
export { CopilotRuntime } from "./copilot/copilot.js";
export {
  COPILOT_STDERR_LOG,
  COPILOT_STDOUT_LOG,
  type DispatchCopilotTaskDeps,
  type DispatchCopilotTaskOpts,
  dispatchCopilotTask,
  type SpawnFn,
} from "./copilot/dispatch-task.js";
export {
  InvalidMcpJson,
  TrustRegistrationFailed,
} from "./copilot/errors.js";
export {
  COPILOT_SESSION_ID_RE,
  generateCopilotSessionId,
  isCopilotSessionId,
} from "./copilot/ids.js";
export { flattenSkillName } from "./copilot/provision.js";
export {
  type CopilotBinResolutionReason,
  type ResolveCopilotBinDeps,
  type ResolvedCopilotBin,
  resolveCopilotBin,
} from "./copilot/resolve-bin.js";
export { isPathCovered } from "./copilot/trust.js";
export {
  RuntimeDispatchTaskFailed,
  RuntimeDoesNotSupportRemoteError,
  RuntimeProvisionFailed,
  RuntimeRefreshFailed,
  RuntimeStateDeletionFailed,
  UnknownRuntimeError,
} from "./errors.js";
export {
  PLACEHOLDER_NAMES,
  type PlaceholderContext,
  type PlaceholderName,
  substitutePlaceholders,
  substitutePlaceholdersDeep,
  UnknownPlaceholderError,
} from "./placeholders.js";
export { RuntimeRegistry } from "./registry.js";
export type {
  ActivityItem,
  AssistantItem,
  Attachment,
  BuildLaunchOpts,
  DispatchTaskOpts,
  LaunchCommand,
  ProvisionContext,
  Runtime,
  RuntimeCapabilities,
  Session,
  SummaryItem,
  SummaryStats,
  SystemItem,
  TaskActivityOpts,
  TaskActivityResult,
  TaskActivityStreamOpts,
  TaskExit,
  TaskHandle,
  TaskStateOpts,
  ThinkingItem,
  TokenUsage,
  ToolCallItem,
  TruncationInfo,
  UserItem,
} from "./types.js";
