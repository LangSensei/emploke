import type { Agent, AgentEntry } from "@emploke/contracts";

const NOW = "2026-05-20T08:00:00.000Z";

function makeAgent(partial: Partial<Agent> & Pick<Agent, "fqn" | "description">): Agent {
  return {
    origin: `https://github.com/LangSensei/emploke-marketplace/tree/main/agents/${partial.fqn}`,
    version: "1.0.0",
    mutable: false,
    prereqsAck: true,
    disabledByUser: false,
    installedAt: NOW,
    updatedAt: NOW,
    ...partial,
  } as Agent;
}

/**
 * AgentEntry list mirrors the server's catalog list endpoint
 * (`GET /api/workspaces/:wsId/catalog/agents`). Each entry pairs the
 * agent DTO with a status + optional blockedReason, exactly like
 * `@emploke/catalog`'s `AgentEntry`.
 */
export const fixtureAgents: AgentEntry[] = [
  {
    agent: makeAgent({
      fqn: "emploke/dev",
      description: "Self-development agent for the emploke control plane.",
    }),
    status: "ready",
  },
  {
    agent: makeAgent({
      fqn: "emploke/review",
      description: "Reviews diffs and surfaces high-signal feedback.",
      version: "0.4.2",
    }),
    status: "ready",
  },
  {
    agent: makeAgent({
      fqn: "emploke/designer",
      description: "Drives the dashboard via Playwright MCP (designer mode).",
      version: "0.1.0-alpha",
    }),
    status: "blocked",
    blockedReason: {
      needsPrereqsAck: true,
    },
  },
];
