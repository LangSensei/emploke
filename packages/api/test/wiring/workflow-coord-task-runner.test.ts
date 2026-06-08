/**
 * Tests for `makeCoordNodeRunner`. Mirrors the structure of the
 * sibling worker runner tests
 * (`workflow-task-runner.test.ts`) — same `vi`-based `TaskService` /
 * `CatalogService` stubs, same `vi.useFakeTimers()` pattern for the
 * poll-tick scenarios, same `fakeTaskRow` helper.
 *
 * The kind-specific concerns the coord runner owns and these tests
 * exercise:
 *
 *   - validate: strict coord spec shape + agent-existence lookup
 *     (`AgentNotFoundError` / `AgentResolutionFailedError`)
 *   - dispatch: reads the workflow header via `getService` thunk;
 *     synthesises `origin: 'workflow'` + canonical
 *     `metadata.workflowNodeId` reverse-lookup key; conditional
 *     `details` spread; throws if `getService()` returns null/undefined
 *   - poll loop status→terminal mapping (`succeeded` / `failed` /
 *     `cancelled` / `null` task), runner-local error budget exhaustion
 *   - hasInFlightForNode pass-through to
 *     `tasks.hasInFlightForWorkflowNode`
 *   - cancel reverse-lookup + per-task `tasks.cancel(...)`,
 *     best-effort behaviour when a per-task cancel throws
 *   - dispose clears every armed interval (no `setInterval` leaks)
 */

import type { CatalogService } from "@emploke/catalog";
import { AgentNotFoundError, AgentResolutionFailedError, type TaskService } from "@emploke/task";
import type { WorkflowService } from "@emploke/workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COORD_MAX_POLL_ERRORS,
  DEFAULT_COORD_POLL_INTERVAL_MS,
  makeCoordNodeRunner,
  WorkflowCoordSpecError,
} from "../../src/wiring/workflow-coord-task-runner.js";

// biome-ignore lint/suspicious/noExplicitAny: minimal Task stub for status-mapping tests; full Task type not needed.
function fakeTaskRow(overrides: Partial<{ id: string; status: string }> = {}): any {
  // Returns a minimal Task-shaped object suitable for the runner's
  // status-mapping logic. We don't import the full Task type because
  // the runner only reads `id`, `status`, `success`, `failure` —
  // and reflectively only when present.
  return {
    id: overrides.id ?? "task-id-1",
    status: overrides.status ?? "running",
    metadata: {},
    agent: "coord-agent",
    brief: "wf-brief",
    origin: "workflow",
    createdAt: "2026-06-07T00:00:00.000Z",
    startedAt: "2026-06-07T00:00:00.000Z",
  };
}

// biome-ignore lint/suspicious/noExplicitAny: minimal WorkflowEntity stub; full entity has more fields the runner does not read.
function fakeWorkflowRow(overrides: { brief?: string; details?: string | undefined } = {}): any {
  return {
    id: "wf-id",
    brief: overrides.brief ?? "wf brief",
    details: "details" in overrides ? overrides.details : "wf details",
    coordinatorAgent: "coord-agent",
    status: "running",
    metadata: {},
    createdAt: "2026-06-07T00:00:00.000Z",
  };
}

function stubDeps(
  opts: {
    agent?: unknown | null;
    getAgentThrows?: Error;
    dispatchReturn?: { id: string };
    // biome-ignore lint/suspicious/noExplicitAny: stub return shape mirrors fakeTaskRow.
    getReturn?: any;
    getThrows?: Error;
    // biome-ignore lint/suspicious/noExplicitAny: stub return shape mirrors fakeTaskRow.
    listInFlightReturn?: any[];
    listInFlightThrows?: Error;
    hasInFlightReturn?: boolean;
    // biome-ignore lint/suspicious/noExplicitAny: stub return shape mirrors fakeWorkflowRow.
    getWorkflowReturn?: any;
    getWorkflowThrows?: Error;
    serviceFromThunk?: WorkflowService | null | undefined;
  } = {},
) {
  const getAgent = vi.fn(async (_fqn: string) => {
    if (opts.getAgentThrows !== undefined) throw opts.getAgentThrows;
    return opts.agent === undefined ? { name: "default-agent" } : opts.agent;
  });
  const dispatch = vi.fn(async () => opts.dispatchReturn ?? fakeTaskRow({ id: "task-id-1" }));
  const get = vi.fn(async (_id: string) => {
    if (opts.getThrows !== undefined) throw opts.getThrows;
    return opts.getReturn !== undefined ? opts.getReturn : fakeTaskRow();
  });
  const hasInFlightForWorkflowNode = vi.fn(async () => opts.hasInFlightReturn ?? false);
  const listInFlightForWorkflowNode = vi.fn(async () => {
    if (opts.listInFlightThrows !== undefined) throw opts.listInFlightThrows;
    return opts.listInFlightReturn ?? [];
  });
  const cancel = vi.fn(async (_id: string) => {});
  const catalog = { getAgent } as unknown as CatalogService;
  const tasks = {
    dispatch,
    get,
    hasInFlightForWorkflowNode,
    listInFlightForWorkflowNode,
    cancel,
  } as unknown as TaskService;

  const getWorkflow = vi.fn(async (_id: string) => {
    if (opts.getWorkflowThrows !== undefined) throw opts.getWorkflowThrows;
    return opts.getWorkflowReturn !== undefined ? opts.getWorkflowReturn : fakeWorkflowRow();
  });
  const fakeService = { getWorkflow } as unknown as WorkflowService;
  const serviceFromThunk = "serviceFromThunk" in opts ? opts.serviceFromThunk : fakeService;
  const getService = vi.fn(() => serviceFromThunk as unknown as WorkflowService);

  return {
    catalog,
    tasks,
    getAgent,
    dispatch,
    get,
    hasInFlightForWorkflowNode,
    listInFlightForWorkflowNode,
    cancel,
    getWorkflow,
    getService,
  };
}

const NODE_VALIDATE_CTX = {
  workflowId: "wf-id",
  callerCoordNodeId: "caller",
  callerCoordSpec: { agent: "coord-agent" },
  workflowStatus: "running" as const,
};

const DISPATCH_OPTS_BASE = {
  workflowId: "wf-id",
  nodeId: "node-id",
  spec: { agent: "coord-agent" } as unknown,
  nodeDir: "/tmp/node-dir",
};

describe("makeCoordNodeRunner — validate", () => {
  it("U1: accepts a minimal valid spec and returns the normalized shape", async () => {
    const deps = stubDeps();
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
    });
    const result = await r.validate({ agent: "x" }, NODE_VALIDATE_CTX);
    expect(result).toEqual({ agent: "x" });
    expect(deps.getAgent).toHaveBeenCalledWith("x");
    await r.dispose();
  });

  it("U2: rejects missing agent key with a message mentioning 'agent'", async () => {
    const deps = stubDeps();
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
    });
    await expect(r.validate({}, NODE_VALIDATE_CTX)).rejects.toBeInstanceOf(WorkflowCoordSpecError);
    await expect(r.validate({}, NODE_VALIDATE_CTX)).rejects.toThrow(/agent/);
    await r.dispose();
  });

  it("U3: rejects empty-string agent with a message mentioning 'non-empty'", async () => {
    const deps = stubDeps();
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
    });
    await expect(r.validate({ agent: "" }, NODE_VALIDATE_CTX)).rejects.toBeInstanceOf(
      WorkflowCoordSpecError,
    );
    await expect(r.validate({ agent: "" }, NODE_VALIDATE_CTX)).rejects.toThrow(/non-empty/);
    await r.dispose();
  });

  it("U4: rejects whitespace-only agent", async () => {
    const deps = stubDeps();
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
    });
    await expect(r.validate({ agent: "   " }, NODE_VALIDATE_CTX)).rejects.toBeInstanceOf(
      WorkflowCoordSpecError,
    );
    await r.dispose();
  });

  it("U5: rejects extra keys (strict shape)", async () => {
    const deps = stubDeps();
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
    });
    await expect(r.validate({ agent: "x", extra: 1 }, NODE_VALIDATE_CTX)).rejects.toBeInstanceOf(
      WorkflowCoordSpecError,
    );
    await r.dispose();
  });

  it("U6: rejects null spec", async () => {
    const deps = stubDeps();
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
    });
    await expect(r.validate(null, NODE_VALIDATE_CTX)).rejects.toBeInstanceOf(
      WorkflowCoordSpecError,
    );
    await r.dispose();
  });

  it("U7: rejects non-object (string) spec", async () => {
    const deps = stubDeps();
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
    });
    await expect(r.validate("x", NODE_VALIDATE_CTX)).rejects.toBeInstanceOf(WorkflowCoordSpecError);
    await r.dispose();
  });

  it("U8: rejects arrays", async () => {
    const deps = stubDeps();
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
    });
    await expect(r.validate([], NODE_VALIDATE_CTX)).rejects.toBeInstanceOf(WorkflowCoordSpecError);
    await r.dispose();
  });

  it("U9: throws AgentNotFoundError when catalog returns null", async () => {
    const deps = stubDeps({ agent: null });
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
    });
    await expect(r.validate({ agent: "missing" }, NODE_VALIDATE_CTX)).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
    await r.dispose();
  });

  it("U10: throws AgentResolutionFailedError wrapping the cause when catalog throws", async () => {
    const cause = new Error("catalog down");
    const deps = stubDeps({ getAgentThrows: cause });
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
    });
    let captured: unknown;
    try {
      await r.validate({ agent: "x" }, NODE_VALIDATE_CTX);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(AgentResolutionFailedError);
    // AgentResolutionFailedError exposes the original error; assert
    // the wrapping carried the cause.
    const wrapped = captured as AgentResolutionFailedError & { cause?: unknown };
    expect(wrapped.cause === cause || (wrapped as unknown as { err?: unknown }).err === cause).toBe(
      true,
    );
    await r.dispose();
  });
});

describe("makeCoordNodeRunner — dispatch", () => {
  it("U11: reads workflow header via getService and calls tasks.dispatch with brief+details from header", async () => {
    const deps = stubDeps({
      getWorkflowReturn: fakeWorkflowRow({ brief: "wf brief", details: "wf details" }),
      // biome-ignore lint/suspicious/noExplicitAny: stub return shape mirrors fakeTaskRow.
      dispatchReturn: fakeTaskRow({ id: "tid-7" }) as any,
    });
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
      pollIntervalMs: 100_000, // never poll during this test
    });
    const result = await r.dispatch({
      ...DISPATCH_OPTS_BASE,
      onTerminal: () => {},
    });
    expect(deps.getService).toHaveBeenCalledTimes(1);
    expect(deps.getWorkflow).toHaveBeenCalledWith("wf-id");
    expect(deps.dispatch).toHaveBeenCalledWith({
      agent: "coord-agent",
      brief: "wf brief",
      details: "wf details",
      origin: "workflow",
      metadata: { workflowId: "wf-id", workflowNodeId: "node-id" },
    });
    expect(result).toEqual({ unitId: "tid-7" });
    await r.dispose();
  });

  it("U12: omits details key from dispatch payload when wf.details === undefined", async () => {
    const deps = stubDeps({
      getWorkflowReturn: fakeWorkflowRow({ brief: "only brief", details: undefined }),
    });
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
      pollIntervalMs: 100_000,
    });
    await r.dispatch({
      ...DISPATCH_OPTS_BASE,
      onTerminal: () => {},
    });
    expect(deps.dispatch).toHaveBeenCalledWith({
      agent: "coord-agent",
      brief: "only brief",
      origin: "workflow",
      metadata: { workflowId: "wf-id", workflowNodeId: "node-id" },
    });
    // Defense-in-depth: assert the literal absence of the `details`
    // key — the runner's conditional spread must not pass
    // `details: undefined` (which some serializers materialize as
    // the literal string "undefined" downstream).
    const calls = deps.dispatch.mock.calls as unknown as ReadonlyArray<
      readonly [Record<string, unknown>]
    >;
    const firstCall = calls[0]?.[0];
    expect(firstCall).toBeDefined();
    if (firstCall !== undefined) {
      expect(Object.keys(firstCall)).not.toContain("details");
    }
    await r.dispose();
  });

  it("U13: throws an actionable error when getService() returns null", async () => {
    const deps = stubDeps({ serviceFromThunk: null });
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
      pollIntervalMs: 100_000,
    });
    let captured: unknown;
    try {
      await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal: () => {} });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain("composeWorkflowModule");
    expect(deps.dispatch).not.toHaveBeenCalled();
    await r.dispose();
  });
});

describe("makeCoordNodeRunner — poll loop terminal mapping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("U14: maps task.status='succeeded' → onTerminal({status:'succeeded'})", async () => {
    const deps = stubDeps({
      getReturn: fakeTaskRow({ status: "succeeded" }),
    });
    const onTerminal = vi.fn();
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
      pollIntervalMs: 100,
    });
    await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal });
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    const arg = onTerminal.mock.calls[0]?.[0];
    expect(arg.status).toBe("succeeded");
    await r.dispose();
  });

  it("U15: maps task.status='failed' → onTerminal({status:'failed', reason})", async () => {
    const failure = { kind: "exited", exit_code: 1, message: "non-zero exit" };
    const deps = stubDeps({
      getReturn: { ...fakeTaskRow({ status: "failed" }), failure },
    });
    const onTerminal = vi.fn();
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
      pollIntervalMs: 100,
    });
    await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal });
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    const arg = onTerminal.mock.calls[0]?.[0];
    expect(arg.status).toBe("failed");
    expect(arg.reason).toBe("non-zero exit");
    await r.dispose();
  });

  it("U16: maps task.status='cancelled' → onTerminal({status:'cancelled'})", async () => {
    const deps = stubDeps({
      getReturn: fakeTaskRow({ status: "cancelled" }),
    });
    const onTerminal = vi.fn();
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
      pollIntervalMs: 100,
    });
    await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal });
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal.mock.calls[0]?.[0]).toEqual({ status: "cancelled" });
    await r.dispose();
  });

  it("U17: exhausts the poll-error budget after maxPollErrors consecutive throws", async () => {
    const deps = stubDeps({ getThrows: new Error("transient boom") });
    const onTerminal = vi.fn();
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
      pollIntervalMs: 100,
      maxPollErrors: 3,
    });
    await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal });
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    const arg = onTerminal.mock.calls[0]?.[0];
    expect(arg.status).toBe("failed");
    expect(String(arg.reason)).toMatch(/tasks\.get exhausted/);
    expect(String(arg.reason)).toMatch(/transient boom/);
    await r.dispose();
  });

  it("U18: maps tasks.get → null → onTerminal({status:'failed', reason:'task not found'})", async () => {
    const deps = stubDeps({ getReturn: null });
    const onTerminal = vi.fn();
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
      pollIntervalMs: 100,
    });
    await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal });
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    const arg = onTerminal.mock.calls[0]?.[0];
    expect(arg.status).toBe("failed");
    expect(arg.reason).toBe("task not found");
    await r.dispose();
  });
});

describe("makeCoordNodeRunner — hasInFlightForNode + cancel + dispose", () => {
  it("U19: hasInFlightForNode delegates to tasks.hasInFlightForWorkflowNode", async () => {
    const deps = stubDeps({ hasInFlightReturn: true });
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
    });
    const result = await r.hasInFlightForNode("node-id");
    expect(result).toBe(true);
    expect(deps.hasInFlightForWorkflowNode).toHaveBeenCalledWith("node-id");
    await r.dispose();
  });

  it("U20: cancel reverse-looks-up via tasks.listInFlightForWorkflowNode and calls tasks.cancel for each + clears any local interval", async () => {
    vi.useFakeTimers();
    try {
      const deps = stubDeps({
        getReturn: fakeTaskRow({ status: "running" }),
        listInFlightReturn: [fakeTaskRow({ id: "t-a" }), fakeTaskRow({ id: "t-b" })],
      });
      const r = makeCoordNodeRunner({
        catalog: deps.catalog,
        tasks: deps.tasks,
        getService: deps.getService,
        pollIntervalMs: 100,
      });
      const onTerminal = vi.fn();
      await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal });
      await vi.advanceTimersByTimeAsync(150);
      await vi.advanceTimersByTimeAsync(0);
      const pollsBeforeCancel = deps.get.mock.calls.length;
      expect(pollsBeforeCancel).toBeGreaterThanOrEqual(1);
      await r.cancel("node-id");
      expect(deps.listInFlightForWorkflowNode).toHaveBeenCalledWith("node-id");
      expect(deps.cancel).toHaveBeenCalledTimes(2);
      expect(deps.cancel).toHaveBeenCalledWith("t-a");
      expect(deps.cancel).toHaveBeenCalledWith("t-b");
      // Interval cleared by cancel — further timer advance must not
      // produce additional polls.
      await vi.advanceTimersByTimeAsync(500);
      expect(deps.get.mock.calls.length).toBe(pollsBeforeCancel);
      await r.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("U21: cancel survives tasks.cancel throwing on one task (best-effort, continues)", async () => {
    const deps = stubDeps({
      listInFlightReturn: [fakeTaskRow({ id: "t-a" }), fakeTaskRow({ id: "t-b" })],
    });
    // biome-ignore lint/suspicious/noExplicitAny: test-only override of the stubbed facade.
    (deps.tasks as any).cancel = vi.fn(async (id: string) => {
      if (id === "t-a") throw new Error("cancel boom");
    });
    const r = makeCoordNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      getService: deps.getService,
    });
    // Should NOT throw; the runner logs and continues.
    await r.cancel("node-id");
    // biome-ignore lint/suspicious/noExplicitAny: test-only access to the overridden mock.
    expect((deps.tasks as any).cancel).toHaveBeenCalledTimes(2);
    await r.dispose();
  });

  it("U22: dispose() clears every armed interval; subsequent timer ticks do not produce polls", async () => {
    vi.useFakeTimers();
    try {
      const deps = stubDeps({ getReturn: fakeTaskRow({ status: "running" }) });
      const r = makeCoordNodeRunner({
        catalog: deps.catalog,
        tasks: deps.tasks,
        getService: deps.getService,
        pollIntervalMs: 100,
      });
      const onTerminal = vi.fn();
      await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal });
      await r.dispatch({
        ...DISPATCH_OPTS_BASE,
        nodeId: "node-id-2",
        onTerminal,
      });
      await vi.advanceTimersByTimeAsync(150);
      const callsBeforeDispose = deps.get.mock.calls.length;
      expect(callsBeforeDispose).toBeGreaterThanOrEqual(2);
      await r.dispose();
      await vi.advanceTimersByTimeAsync(500);
      expect(deps.get.mock.calls.length).toBe(callsBeforeDispose);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("makeCoordNodeRunner — exported constants + factory shape", () => {
  it("exposes default poll interval + max poll errors constants", () => {
    expect(DEFAULT_COORD_POLL_INTERVAL_MS).toBe(2000);
    expect(DEFAULT_COORD_MAX_POLL_ERRORS).toBe(3);
  });

  it("WorkflowCoordSpecError sets the canonical .name for instanceof routing", () => {
    const err = new WorkflowCoordSpecError("bad spec");
    expect(err.name).toBe("WorkflowCoordSpecError");
    expect(err.message).toBe("bad spec");
    expect(err).toBeInstanceOf(Error);
  });
});
