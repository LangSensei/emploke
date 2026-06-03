import type { ResolvedAgent, Runtime } from "@emploke/runtime";
import {
  AgentNotFoundError,
  AgentResolutionFailedError,
  EntryNotReadyError,
  RuntimeDoesNotSupportTasksError,
} from "../errors.js";
import type { TaskServiceCtx } from "../task-service.js";

/**
 * Resolve an agent name to a runnable `ResolvedAgent` via the agent
 * resolver port. Performs the cascade-aware status check — refuses
 * dispatch on blocked agents (prereqs not acknowledged, agent
 * disabled, or any transitive skill missing/blocked). Throws
 * `AgentNotFoundError` for unknown agents (`getAgentEntry` returns
 * null), `EntryNotReadyError` for blocked entries, and
 * `AgentResolutionFailedError` (500) for unexpected resolver faults.
 *
 * Discrimination is via `null` return from `getAgentEntry` + generic
 * catch on `resolveAgent`; the port deliberately does NOT expose an
 * "agent not found" error class — any thrown error from
 * `resolveAgent` is classified as a 500. TOCTOU note: an agent
 * disappearing between `getAgentEntry` and `resolveAgent` surfaces
 * as `AgentResolutionFailedError` (500) rather than
 * `AgentNotFoundError` (400) — accepted as vanishingly rare in
 * practice.
 */
export async function resolveDispatchAgent(
  ctx: TaskServiceCtx,
  agentName: string,
): Promise<ResolvedAgent> {
  const entry = await ctx.agentResolver.getAgentEntry(agentName);
  if (entry === null) {
    throw new AgentNotFoundError(agentName);
  }
  if (entry.status === "blocked") {
    throw new EntryNotReadyError(agentName, entry.blockedReason);
  }
  try {
    return await ctx.agentResolver.resolveAgent(agentName);
  } catch (err) {
    throw new AgentResolutionFailedError(agentName, err);
  }
}

/**
 * Look up a runtime by kind and verify it supports headless task
 * launch. Throws `RuntimeDoesNotSupportTasksError` if the runtime is
 * registered but cannot launch tasks. Called before reserving a
 * workdir so a misconfiguration doesn't litter empty dirs on disk.
 *
 * The return type narrows `launchHeadless` to non-optional so the
 * dispatch flow can call it without an additional defensive check.
 */
export function pickRuntime(
  ctx: TaskServiceCtx,
  runtimeKind: string,
): Runtime & { launchHeadless: NonNullable<Runtime["launchHeadless"]> } {
  const runtime = ctx.runtimeRegistry.get(runtimeKind);
  if (typeof runtime.launchHeadless !== "function") {
    throw new RuntimeDoesNotSupportTasksError(runtime.kind);
  }
  return runtime as Runtime & { launchHeadless: NonNullable<Runtime["launchHeadless"]> };
}
