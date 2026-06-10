import type { AgentEntry } from "@emploke/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowHeaderWire } from "../src/api";
import { ApiError } from "../src/api";

vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ...actual,
    createWorkflow: vi.fn(),
  };
});

import * as api from "../src/api";
import { CreateWorkflowModal } from "../src/components/workflows/CreateWorkflowModal";

const mockCreateWorkflow = api.createWorkflow as unknown as ReturnType<typeof vi.fn>;

function makeAgent(fqn: string, opts: { coordEligible?: boolean } = {}): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: { fqn, scope, short, version: "1.0.0" },
    status: "ready",
    coordEligible: opts.coordEligible ?? true,
  } as unknown as AgentEntry;
}

function makeWorkflow(): WorkflowHeaderWire {
  return {
    id: "wf-from-server",
    brief: "from-server",
    status: "running",
    coordinatorAgent: "emploke/dev",
    metadata: {},
    createdAt: "2026-05-28T00:00:00.000Z",
    iterationCount: 0,
  };
}

beforeEach(() => {
  mockCreateWorkflow.mockReset();
  mockCreateWorkflow.mockResolvedValue(makeWorkflow());
});

afterEach(() => cleanup());

describe("CreateWorkflowModal — submit enabling", () => {
  it("submit button is disabled until brief is non-empty", () => {
    render(
      <CreateWorkflowModal
        open={true}
        agents={[makeAgent("emploke/dev")]}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    const submit = screen.getByTestId("create-workflow-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const briefInput = screen.getByTestId("create-workflow-brief") as HTMLInputElement;
    fireEvent.change(briefInput, { target: { value: "Plan it" } });
    expect(submit.disabled).toBe(false);
  });

  it("submit button is disabled when no agents are installed", () => {
    render(<CreateWorkflowModal open={true} agents={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    const submit = screen.getByTestId("create-workflow-submit") as HTMLButtonElement;
    fireEvent.change(screen.getByTestId("create-workflow-brief"), {
      target: { value: "Plan it" },
    });
    expect(submit.disabled).toBe(true);
  });
});

// AC1: dropdown source restricted to coord-eligible agents. The
// substrate's coord-capability invariant ("agent declares non-empty
// `dependencies.agents`") is computed server-side onto
// `AgentEntry.coordEligible`; the modal MUST filter on that field
// alone (no client-side re-derivation).
describe("CreateWorkflowModal — coord-eligible dropdown", () => {
  it("dropdown lists only agents with coordEligible=true", () => {
    render(
      <CreateWorkflowModal
        open={true}
        agents={[
          makeAgent("emploke/coordinator", { coordEligible: true }),
          makeAgent("emploke/dev", { coordEligible: false }),
          makeAgent("emploke/review", { coordEligible: false }),
        ]}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    const select = screen.getByTestId("create-workflow-agent") as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toEqual(["emploke/coordinator"]);
    // The default selection lands on the only eligible agent.
    expect(select.value).toBe("emploke/coordinator");
  });

  it("dropdown shows the empty placeholder when no agents are coord-eligible", () => {
    render(
      <CreateWorkflowModal
        open={true}
        agents={[
          makeAgent("emploke/dev", { coordEligible: false }),
          makeAgent("emploke/review", { coordEligible: false }),
        ]}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    const select = screen.getByTestId("create-workflow-agent") as HTMLSelectElement;
    expect(select.options).toHaveLength(1);
    expect(select.options[0]?.textContent).toMatch(/no coord-eligible/i);
    expect(select.disabled).toBe(true);
  });
});

describe("CreateWorkflowModal — submit body", () => {
  it("omits `details` when the details field is empty", async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(
      <CreateWorkflowModal
        open={true}
        agents={[makeAgent("emploke/dev")]}
        onClose={onClose}
        onCreated={onCreated}
      />,
    );
    fireEvent.change(screen.getByTestId("create-workflow-brief"), {
      target: { value: "Plan it" },
    });
    fireEvent.click(screen.getByTestId("create-workflow-submit"));
    await waitFor(() => expect(mockCreateWorkflow).toHaveBeenCalledTimes(1));
    expect(mockCreateWorkflow).toHaveBeenCalledWith({
      brief: "Plan it",
      coordinatorAgent: "emploke/dev",
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalled();
  });

  it("includes `details` when the details field is filled in", async () => {
    render(
      <CreateWorkflowModal
        open={true}
        agents={[makeAgent("emploke/dev")]}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("create-workflow-brief"), {
      target: { value: "Plan it" },
    });
    fireEvent.change(screen.getByTestId("create-workflow-details"), {
      target: { value: "Lots of context" },
    });
    fireEvent.click(screen.getByTestId("create-workflow-submit"));
    await waitFor(() => expect(mockCreateWorkflow).toHaveBeenCalledTimes(1));
    expect(mockCreateWorkflow).toHaveBeenCalledWith({
      brief: "Plan it",
      coordinatorAgent: "emploke/dev",
      details: "Lots of context",
    });
  });

  it("surfaces a submit error inline without closing the modal", async () => {
    mockCreateWorkflow.mockRejectedValueOnce(new Error("boom"));
    const onClose = vi.fn();
    render(
      <CreateWorkflowModal
        open={true}
        agents={[makeAgent("emploke/dev")]}
        onClose={onClose}
        onCreated={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("create-workflow-brief"), {
      target: { value: "Plan it" },
    });
    fireEvent.click(screen.getByTestId("create-workflow-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("create-workflow-submit-error").textContent).toContain("boom"),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});

// AC3: when the server pins a rejection to the `coordinatorAgent`
// field (structured 4xx with field === "coordinatorAgent"), the
// modal renders the error inline next to the select instead of as a
// form-level banner. The form stays submittable so the user can
// switch agents without retyping the brief.
describe("CreateWorkflowModal — field-scoped error rendering", () => {
  it("renders a coord-agent ApiError inline next to the agent select", async () => {
    mockCreateWorkflow.mockRejectedValueOnce(
      new ApiError(
        'Workflow coordinator agent "emploke/dev" declares no `dependencies.agents` dispatch menu.',
        {
          status: 400,
          code: "WorkflowCoordAgentNotCapableError",
          field: "coordinatorAgent",
        },
      ),
    );
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(
      <CreateWorkflowModal
        open={true}
        agents={[makeAgent("emploke/dev")]}
        onClose={onClose}
        onCreated={onCreated}
      />,
    );
    fireEvent.change(screen.getByTestId("create-workflow-brief"), {
      target: { value: "Plan it" },
    });
    fireEvent.click(screen.getByTestId("create-workflow-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("create-workflow-agent-error").textContent).toContain(
        "dispatch menu",
      ),
    );
    // The full-form banner stays absent — the inline message is the
    // sole error surface for this rejection.
    expect(screen.queryByTestId("create-workflow-submit-error")).toBeNull();
    // The modal does NOT close, the create handler does NOT fire,
    // and the user's brief is preserved so they can switch agents
    // and resubmit.
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect((screen.getByTestId("create-workflow-brief") as HTMLInputElement).value).toBe("Plan it");
    const submit = screen.getByTestId("create-workflow-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it("falls back to the form-level banner for non-field-scoped errors", async () => {
    // Same ApiError shape, but the field slot is absent — must NOT
    // be misrouted to the agent-select inline surface.
    mockCreateWorkflow.mockRejectedValueOnce(new ApiError("server is down", { status: 503 }));
    render(
      <CreateWorkflowModal
        open={true}
        agents={[makeAgent("emploke/dev")]}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("create-workflow-brief"), {
      target: { value: "Plan it" },
    });
    fireEvent.click(screen.getByTestId("create-workflow-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("create-workflow-submit-error").textContent).toContain(
        "server is down",
      ),
    );
    expect(screen.queryByTestId("create-workflow-agent-error")).toBeNull();
  });
});
