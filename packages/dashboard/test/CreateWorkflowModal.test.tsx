import type { AgentEntry } from "@emploke/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowHeaderWire } from "../src/api";

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

function makeAgent(fqn: string): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: { fqn, scope, short, version: "1.0.0" },
    status: "ready",
  } as unknown as AgentEntry;
}

function makeWorkflow(): WorkflowHeaderWire {
  return {
    id: "wf-from-server",
    brief: "from-server",
    status: "running",
    coordinatorAgent: "emploke/dev",
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
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
