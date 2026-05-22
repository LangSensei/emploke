// Public surface for @emploke/runtime.

export type { CopilotRuntimeConfig } from "./copilot/copilot-runtime.js";
// Copilot runtime
export { CopilotRuntime } from "./copilot/copilot-runtime.js";
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
  COPILOT_MCP_CONFIG,
  type EventBuffer,
  type LaunchCopilotHeadlessDeps,
  type LaunchCopilotHeadlessOpts,
  launchCopilotHeadless,
} from "./copilot/launch-headless.js";
export { flattenSkillName } from "./copilot/provision.js";
export { isPathCovered } from "./copilot/trust.js";
export {
  RuntimeDoesNotSupportRemoteError,
  RuntimeHeadlessLaunchFailed,
  RuntimeProvisionFailed,
  RuntimeReadActivityInvalidArgs,
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
export { RuntimeRegistry } from "./runtime-registry.js";
export { SHARED_SUBDIR, sharedDir } from "./shared-dir.js";
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
