import type { AgentEntry, SkillEntry } from "@emploke/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { McpItem } from "../../src/api/catalog";
import { CatalogPage } from "../../src/pages/Catalog";

/**
 * Catalog row "N agents" chip lock-in. An agent with non-empty
 * `dependencies.agents` must surface the chip in its card footer; an
 * agent with no agent deps must NOT render it (the chip is suppressed
 * at `agentsCount <= 0` so the existing zero-deps card layout is
 * preserved).
 *
 * Mirrors the rendering convention for the skills / mcps chips already
 * exercised by `CatalogAgentHint.test.tsx`.
 */

function makeAgent(fqn: string, agentDeps: string[] = []): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: {
      fqn,
      scope,
      short,
      description: `${fqn} description`,
      version: "1.0.0",
      mutable: true,
      ...(agentDeps.length > 0
        ? { dependencies: { agents: agentDeps.map((f) => ({ fqn: f })) } }
        : {}),
    },
    status: "ready",
    missingDeps: [],
  } as unknown as AgentEntry;
}

function renderCatalog(agents: AgentEntry[]) {
  return render(
    <MemoryRouter initialEntries={["/workspaces/ws-1/catalog/agents"]}>
      <Routes>
        <Route
          path="/workspaces/:wsId/catalog/agents"
          element={
            <CatalogPage
              tab="agents"
              onTabChange={() => {}}
              skills={[] as SkillEntry[]}
              agents={agents}
              mcps={[] as McpItem[]}
              currentWorkspaceId="ws-1"
              onChanged={() => {}}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe("Catalog agent rows — agent→agent deps chip", () => {
  it("renders a `N agents` chip for an agent with non-empty dependencies.agents", () => {
    renderCatalog([makeAgent("emploke/dev", ["emploke/review", "emploke/qa"])]);
    expect(screen.getByText("2 agents")).toBeTruthy();
  });

  it("uses the singular `1 agent` label when only one agent dep is present", () => {
    renderCatalog([makeAgent("emploke/dev", ["emploke/review"])]);
    expect(screen.getByText("1 agent")).toBeTruthy();
  });

  it("suppresses the chip entirely for an agent with no agent deps", () => {
    renderCatalog([makeAgent("emploke/lonely")]);
    expect(screen.queryByText(/\bagents?\b$/)).toBeNull();
    expect(screen.queryByText("0 agents")).toBeNull();
  });
});
