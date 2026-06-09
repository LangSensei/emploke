import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveWorkspace } from "../src/api";
import { PatchDialog } from "../src/pages/catalog/PatchDialog";

/**
 * PatchDialog round-trip lock-in for agent→agent edges.
 *
 * 1. GET /catalog/agents/:fqn returns an agent whose `dependencies.agents`
 *    has two entries.
 * 2. Dialog mounts in form mode, populates the Agent dependencies chip
 *    group with both entries.
 * 3. User clicks × on one chip, then Save.
 * 4. PATCH /catalog/agents/:fqn fires with `dependencies.agents`
 *    reduced to the kept entry (still wrapped in the `dependencies`
 *    object since other dep arrays are also populated).
 */

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

const AGENT_FQN = "emploke/dev";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function emptyOk(): Response {
  return new Response(null, { status: 204 });
}

beforeEach(() => {
  setActiveWorkspace("ws-1");
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
    };
  }
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  setActiveWorkspace(null);
  vi.restoreAllMocks();
});

describe("PatchDialog — agent→agent deps round-trip", () => {
  it("posts the reduced agents list when an agent chip is removed", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.endsWith(`/catalog/agents/${encodeURIComponent(AGENT_FQN)}`)) {
        return jsonResponse({
          agent: {
            fqn: AGENT_FQN,
            origin: "file:/tmp/dev",
            description: "dev agent",
            version: "1.0.0",
            mutable: true,
            prereqsAck: true,
            disabledByUser: false,
            installedAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            dependencies: {
              skills: [],
              mcps: [],
              agents: [{ fqn: "emploke/review" }, { fqn: "emploke/qa" }],
            },
          },
          status: "ready",
          content: "# dev agent",
        });
      }
      if (method === "PATCH") {
        return emptyOk();
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const onSaved = vi.fn();
    render(
      <PatchDialog
        kind="agent"
        name={AGENT_FQN}
        availableSkills={[]}
        availableMcps={[]}
        availableAgents={["emploke/review", "emploke/qa"]}
        onClose={() => {}}
        onSaved={onSaved}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("emploke/review")).toBeTruthy();
      expect(screen.getByText("emploke/qa")).toBeTruthy();
    });

    // Remove the `emploke/qa` chip via its × button (aria-label
    // matches the ChipsInput template literal).
    const removeQa = screen.getByLabelText("Remove emploke/qa");
    fireEvent.click(removeQa);

    await waitFor(() => {
      expect(screen.queryByText("emploke/qa")).toBeNull();
    });

    // Save → PATCH body.
    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });

    // Find the PATCH call and parse its body.
    const patchCall = fetchMock.mock.calls.find(([, init]) => {
      const m = (init as RequestInit | undefined)?.method;
      return typeof m === "string" && m.toUpperCase() === "PATCH";
    });
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(String((patchCall![1] as RequestInit).body));
    expect(body.dependencies).toEqual({
      skills: [],
      mcps: [],
      agents: ["emploke/review"],
    });
  });

  it("does NOT forward an `agents` array when the kind is skill", async () => {
    const SKILL_FQN = "emploke/some-skill";
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.endsWith(`/catalog/skills/${encodeURIComponent(SKILL_FQN)}`)) {
        return jsonResponse({
          skill: {
            fqn: SKILL_FQN,
            origin: "file:/tmp/skill",
            description: "skill",
            version: "1.0.0",
            mutable: true,
            prereqsAck: true,
            orphaned: false,
            installedAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            dependencies: {
              skills: [{ fqn: "emploke/dep-skill" }],
              mcps: [],
            },
          },
          status: "ready",
          content: "# skill",
        });
      }
      if (method === "PATCH") {
        return emptyOk();
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const onSaved = vi.fn();
    render(
      <PatchDialog
        kind="skill"
        name={SKILL_FQN}
        availableSkills={["emploke/dep-skill"]}
        availableMcps={[]}
        availableAgents={[]}
        onClose={() => {}}
        onSaved={onSaved}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("emploke/dep-skill")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });

    const patchCall = fetchMock.mock.calls.find(([, init]) => {
      const m = (init as RequestInit | undefined)?.method;
      return typeof m === "string" && m.toUpperCase() === "PATCH";
    });
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(String((patchCall![1] as RequestInit).body));
    expect(body.dependencies).toEqual({
      skills: ["emploke/dep-skill"],
      mcps: [],
    });
    // Critical: the skill adapter must NOT forward an `agents` array.
    expect("agents" in body.dependencies).toBe(false);
  });
});
