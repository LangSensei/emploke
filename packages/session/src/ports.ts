/**
 * Port interfaces consumed by @emploke/session. See task's ports.ts
 * for the rationale; this file mirrors the same pattern (cf.
 * runtime/src/types.ts:1-15). The session port is narrower than
 * task's because session never reads BlockedReason fields.
 *
 * Not-found discrimination is via `null` return from `getAgentEntry`
 * (Decision #9 — Option II locked). The catalog AgentNotFoundError
 * class is irrelevant and not imported.
 */

import type { ResolvedAgent } from "@emploke/runtime";

export interface AgentEntry {
  readonly status: "ready" | "blocked";
}

export interface AgentResolverPort {
  getAgentEntry(name: string): Promise<AgentEntry | null>;
  resolveAgent(name: string): Promise<ResolvedAgent>;
}
