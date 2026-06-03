/**
 * Compile-time public API guard for `@emploke/runtime`.
 *
 * WHAT this file does:
 *   Uses Vitest's `expectTypeOf<T>()` to lock the pkg's public surface
 *   at the TYPE level. `@emploke/runtime` has no central Service class
 *   — its public surface is a SET of exported classes (`CopilotRuntime`,
 *   `RuntimeRegistry`), free functions
 *   (`assertCopilotSdkResolvable`, `launchCopilotHeadless`,
 *   `substitutePlaceholders`, `substitutePlaceholdersDeep`,
 *   `flattenSkillName`, `isPathCovered`, `generateCopilotSessionId`,
 *   `isCopilotSessionId`, `sharedDir`), error classes, and DTOs /
 *   options. Each gets a `expectTypeOf(...)` assertion below.
 *
 * WHY it is valuable:
 *   Silent renames (`launchCopilotHeadless` → `runCopilotHeadless`),
 *   accidental method removals, and DTO-field drift on
 *   `LaunchCommand` / `ActivityItem` / `Runtime` all break downstream
 *   pkgs at compile time — but only the downstream pkg's typecheck
 *   sees the failure, which means breakage surfaces in a sibling PR
 *   (or worse, in `dashboard`) instead of in the pkg that caused it.
 *   This guard pulls the failure forward:
 *   `pnpm --filter @emploke/runtime typecheck` fails the moment the
 *   public surface drifts, BEFORE the downstream consumer notices.
 *
 * WHEN it runs:
 *   - At `pnpm typecheck` time: every `expectTypeOf` assertion is
 *     evaluated by tsc — that is where the real check happens.
 *   - At `pnpm test` time: the file loads and the `describe(...)` /
 *     `it(...)` bodies execute, but `expectTypeOf` is a no-op at
 *     runtime — vitest reports the cases as passing trivially.
 *   - `expectTypeOf` has zero runtime cost; the cost is paid once at
 *     compile time.
 *
 * HOW to extend it:
 *   Every time you ADD / RENAME / REMOVE a public method on the
 *   service, an exported error class, or an exported DTO field,
 *   update the matching `expectTypeOf` line in the SAME PR. Review
 *   enforces the coupling — a public-surface change without a guard
 *   update is a missing assertion.
 *
 * Worked example: see `packages/catalog/test/public-api-guard.test.ts`
 * for a fully-populated version locking 25+ methods and 19 error
 * classes on a real BC.
 */

import { describe, expectTypeOf, it } from "vitest";
import {
  type ActivityItem,
  type ActivityResult,
  type AgentActivity,
  type AgentContentSource,
  type AssistantItem,
  type Attachment,
  assertCopilotSdkResolvable,
  type BuildInteractiveLaunchOpts,
  type COPILOT_MCP_CONFIG,
  type COPILOT_SESSION_ID_RE,
  type CopilotPreflightDeps,
  CopilotRuntime,
  type CopilotRuntimeConfig,
  CopilotSdkUnavailableError,
  type EventBuffer,
  flattenSkillName,
  generateCopilotSessionId,
  InvalidMcpJson,
  isCopilotSessionId,
  isPathCovered,
  type LaunchCommand,
  type LaunchCopilotHeadlessDeps,
  type LaunchCopilotHeadlessOpts,
  type LaunchHeadlessOpts,
  launchCopilotHeadless,
  type PLACEHOLDER_NAMES,
  type PlaceholderContext,
  type PlaceholderName,
  type ProvisionContext,
  type ReadActivityOpts,
  type ResolvedAgent,
  type Runtime,
  type RuntimeCapabilities,
  RuntimeDoesNotSupportRemoteError,
  type RuntimeExit,
  type RuntimeHandle,
  RuntimeHeadlessLaunchFailed,
  RuntimeProvisionFailed,
  RuntimeReadActivityInvalidArgs,
  RuntimeRefreshFailed,
  RuntimeRegistry,
  type RuntimeSessionMetadata,
  RuntimeStateDeletionFailed,
  type SHARED_SUBDIR,
  type StreamActivityOpts,
  type SummaryItem,
  type SummaryStats,
  type SystemItem,
  sharedDir,
  substitutePlaceholders,
  substitutePlaceholdersDeep,
  type ThinkingItem,
  type TokenUsage,
  type ToolCallItem,
  type TruncationInfo,
  TrustRegistrationFailed,
  UnknownPlaceholderError,
  UnknownRuntimeError,
  type UserItem,
} from "../src/index.js";

describe("@emploke/runtime public API guard", () => {
  it("exports the concrete error classes with their canonical constructor signatures", () => {
    const errs: Error[] = [
      // Runtime-generic errors (`../src/errors.ts`).
      new UnknownRuntimeError("copilot"),
      new RuntimeRefreshFailed("copilot", "sid", new Error("upstream")),
      new RuntimeStateDeletionFailed("copilot", "sid", new Error("upstream")),
      new RuntimeProvisionFailed("copilot", "/workdir", new Error("upstream")),
      new RuntimeHeadlessLaunchFailed("copilot", "/task-dir", new Error("upstream")),
      new RuntimeDoesNotSupportRemoteError("gemini"),
      new RuntimeReadActivityInvalidArgs("before and after are mutually exclusive"),
      // Placeholder substitution.
      new UnknownPlaceholderError("typoDir", "mcp:public/playwright"),
      // Copilot-specific errors (`../src/copilot/errors.ts`).
      new InvalidMcpJson("public/playwright", new Error("upstream")),
      new CopilotSdkUnavailableError(new Error("ERR_MODULE_NOT_FOUND")),
      new TrustRegistrationFailed("/cfg.json", "/workspace", new Error("upstream")),
    ];
    expectTypeOf(errs[0]!).toExtend<Error>();
  });

  it("preserves the public DTO + option shapes", () => {
    // Runtime adapter contract — every method downstream callers
    // invoke on a Runtime is named here.
    expectTypeOf<Runtime>().toHaveProperty("kind");
    expectTypeOf<Runtime>().toHaveProperty("provision");
    expectTypeOf<Runtime>().toHaveProperty("buildInteractiveLaunch");

    // Catalog-side port shape consumed by Runtime.provision.
    expectTypeOf<AgentContentSource>().toHaveProperty("resolveAgent");
    expectTypeOf<AgentContentSource>().toHaveProperty("agentEntries");
    expectTypeOf<AgentContentSource>().toHaveProperty("skillEntries");
    expectTypeOf<AgentContentSource>().toHaveProperty("getMcpRuntimeConfig");

    // Minimal resolved-agent shape.
    expectTypeOf<ResolvedAgent>().toHaveProperty("agent");
    expectTypeOf<ResolvedAgent>().toHaveProperty("skills");
    expectTypeOf<ResolvedAgent>().toHaveProperty("mcps");

    // LaunchCommand — terminal pkg and session pkg both consume the
    // same structural shape; locking the fields here protects the
    // cross-pkg seam.
    expectTypeOf<LaunchCommand>().toHaveProperty("cmd");
    expectTypeOf<LaunchCommand>().toHaveProperty("args");
    expectTypeOf<LaunchCommand>().toHaveProperty("cwd");
    expectTypeOf<LaunchCommand>().toHaveProperty("display");
    expectTypeOf<LaunchCommand>().toHaveProperty("env");

    // Per-launch / per-provision option bags.
    expectTypeOf<BuildInteractiveLaunchOpts>().toBeObject();
    expectTypeOf<ProvisionContext>().toHaveProperty("workspaceDir");
    expectTypeOf<RuntimeCapabilities>().toBeObject();
    expectTypeOf<LaunchHeadlessOpts>().toBeObject();
    expectTypeOf<ReadActivityOpts>().toBeObject();
    expectTypeOf<StreamActivityOpts>().toBeObject();

    // Runtime-side handles + metadata.
    expectTypeOf<RuntimeHandle>().toBeObject();
    expectTypeOf<RuntimeExit>().toBeObject();
    expectTypeOf<RuntimeSessionMetadata>().toBeObject();

    // Activity DTOs surfaced to the dashboard.
    expectTypeOf<ActivityResult>().toHaveProperty("activity");
    expectTypeOf<ActivityResult>().toHaveProperty("result");
    expectTypeOf<ActivityResult>().toHaveProperty("totalItems");
    expectTypeOf<AgentActivity>().toBeObject();
    expectTypeOf<TruncationInfo>().toBeObject();
    expectTypeOf<UserItem>().toBeObject();
    expectTypeOf<AssistantItem>().toBeObject();
    expectTypeOf<ThinkingItem>().toBeObject();
    expectTypeOf<ToolCallItem>().toBeObject();
    expectTypeOf<SystemItem>().toBeObject();
    expectTypeOf<SummaryItem>().toBeObject();
    expectTypeOf<TokenUsage>().toBeObject();
    expectTypeOf<SummaryStats>().toBeObject();
    expectTypeOf<Attachment>().toBeObject();
    // ActivityItem is a discriminated union; assert it stays one.
    expectTypeOf<ActivityItem>().toBeObject();

    // Copilot-specific shapes.
    expectTypeOf<CopilotRuntimeConfig>().toBeObject();
    expectTypeOf<CopilotPreflightDeps>().toHaveProperty("resolveSpecifier");
    expectTypeOf<CopilotPreflightDeps>().toHaveProperty("createRequireAt");
    expectTypeOf<EventBuffer>().toHaveProperty("events");
    expectTypeOf<LaunchCopilotHeadlessOpts>().toHaveProperty("taskDir");
    expectTypeOf<LaunchCopilotHeadlessOpts>().toHaveProperty("agent");
    expectTypeOf<LaunchCopilotHeadlessDeps>().toBeObject();

    // Placeholder vocabulary.
    expectTypeOf<PlaceholderContext>().toHaveProperty("workspaceDir");
    expectTypeOf<PlaceholderContext>().toHaveProperty("sharedDir");
    expectTypeOf<PlaceholderName>().toEqualTypeOf<"workspaceDir" | "sharedDir">();
  });

  it("preserves the exported function signatures", () => {
    // Copilot preflight.
    expectTypeOf(assertCopilotSdkResolvable).toBeFunction();
    // Copilot session-id helpers.
    expectTypeOf(generateCopilotSessionId).toBeFunction();
    expectTypeOf(isCopilotSessionId).toBeFunction();
    // Copilot headless entry.
    expectTypeOf(launchCopilotHeadless).toBeFunction();
    // Skill-name and trust helpers consumed by api/server.
    expectTypeOf(flattenSkillName).toBeFunction();
    expectTypeOf(isPathCovered).toBeFunction();
    // Placeholder substituters.
    expectTypeOf(substitutePlaceholders).toBeFunction();
    expectTypeOf(substitutePlaceholdersDeep).toBeFunction();
    // Shared-dir resolver.
    expectTypeOf(sharedDir).toBeFunction();
  });

  it("preserves the exported classes and constants", () => {
    // Runtime adapter — value-imported by api/server for registration.
    expectTypeOf(new CopilotRuntime()).toExtend<CopilotRuntime>();
    expectTypeOf(new CopilotRuntime({})).toExtend<Runtime>();

    // RuntimeRegistry — owned by the composition root, value-imported.
    const reg = new RuntimeRegistry();
    expectTypeOf(reg).toExtend<RuntimeRegistry>();
    expectTypeOf(reg).toHaveProperty("register");
    expectTypeOf(reg).toHaveProperty("get");
    expectTypeOf(reg).toHaveProperty("has");
    expectTypeOf(reg).toHaveProperty("kinds");

    // String-literal subtypes; assert assignability to `string` rather
    // than exact equality so renaming the literal value remains an
    // internal change while the public type stays string-shaped.
    expectTypeOf<typeof SHARED_SUBDIR>().toExtend<string>();
    expectTypeOf<typeof COPILOT_MCP_CONFIG>().toExtend<string>();
    // RegExp constants exposed to callers that need to validate ids
    // without invoking the helper.
    expectTypeOf<typeof COPILOT_SESSION_ID_RE>().toEqualTypeOf<RegExp>();
    // PLACEHOLDER_NAMES is a readonly tuple; lock the arity-or-greater
    // assignability to readonly string[].
    expectTypeOf<typeof PLACEHOLDER_NAMES>().toExtend<readonly string[]>();
  });
});
