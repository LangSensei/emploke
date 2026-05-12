// Public surface for @emploke/runtime.

export type { CopilotRuntimeConfig } from "./copilot/copilot.js";
// Copilot runtime
export { CopilotRuntime } from "./copilot/copilot.js";
export {
  InvalidMcpJson,
  TrustRegistrationFailed,
} from "./copilot/errors.js";
export {
  COPILOT_SESSION_ID_RE,
  generateCopilotSessionId,
  isCopilotSessionId,
} from "./copilot/ids.js";
export {
  COPILOT_STDERR_LOG,
  COPILOT_STDOUT_LOG,
  type LaunchCopilotHeadlessDeps,
  type LaunchCopilotHeadlessOpts,
  launchCopilotHeadless,
  type SpawnFn,
} from "./copilot/launch-headless.js";
export { flattenSkillName } from "./copilot/provision.js";
export {
  type CopilotBinResolutionReason,
  type ResolveCopilotBinDeps,
  type ResolvedCopilotBin,
  resolveCopilotBin,
} from "./copilot/resolve-bin.js";
export { isPathCovered } from "./copilot/trust.js";
export {
  RuntimeDoesNotSupportRemoteError,
  RuntimeHeadlessLaunchFailed,
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
  ActivityResult,
  AssistantItem,
  Attachment,
  BuildInteractiveLaunchOpts,
  LaunchCommand,
  LaunchHeadlessOpts,
  ProvisionContext,
  ReadActivityOpts,
  Runtime,
  RuntimeCapabilities,
  RuntimeExit,
  RuntimeHandle,
  RuntimeSessionMetadata,
  StreamActivityOpts,
  SummaryItem,
  SummaryStats,
  SystemItem,
  ThinkingItem,
  TokenUsage,
  ToolCallItem,
  TruncationInfo,
  UserItem,
} from "./types.js";
