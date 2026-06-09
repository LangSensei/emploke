/**
 * Tests for `makeWorkerNodeRunner`. Mirrors the structure of
 * `schedule-task-handler.test.ts` — uses mocked `TaskService` +
 * `CatalogService` to exercise the runner in isolation, focusing on
 * the kind-specific concerns the runner owns:
 *
 *   - validate: shape checks + agent-existence lookup
 *     (`AgentNotFoundError` / `AgentResolutionFailedError`)
 *   - dispatch: synthesises `origin: 'workflow'` + canonical
 *     `metadata.workflowNodeId` reverse-lookup key; installs the
 *     per-node poll interval and returns `void` (the runner logs the
 *     task id at info inside dispatch for audit / log correlation)
 *   - poll loop status→terminal mapping (`succeeded` / `failed` /
 *     `cancelled` / `null` task), runner-local error budget exhaustion
 *   - hasInFlightForNode pass-through to
 *     `tasks.hasInFlightForWorkflowNode`
 *   - cancel reverse-lookup + per-task `tasks.cancel(...)`,
 *     idempotency on duplicate cancel
 *   - dispose clears every armed interval (no `setInterval` leaks)
 *
 * A variant using a REAL `TaskService` + no-op runtime is possible.
 * Two reasons we use mocks here instead:
 *   1. The schedule-task-handler tests next to this one use mocks
 *      — staying consistent with that precedent keeps the api-pkg
 *      test surface uniform.
 *   2. The runner's responsibilities are entirely about the
 *      task-service interface; standing up a real TaskService would
 *      verify TaskService's behavior, not the runner's.
 * The engine-integration test (`packages/workflow/test/engine-integration.test.ts`)
 * already exercises the engine ↔ runner pipeline end-to-end with a
 * fake runner; together the two tiers cover every invariant the
 * runner is responsible for without the cost of a real TaskService
 * boot in this layer.
 */

import type { CatalogService } from "@emploke/catalog";
import { AgentNotFoundError, AgentResolutionFailedError, type TaskService } from "@emploke/task";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKER_MAX_POLL_ERRORS,
  DEFAULT_WORKER_POLL_INTERVAL_MS,
  makeWorkerNodeRunner,
  WorkflowWorkerSpecError,
} from "../../src/wiring/workflow-task-runner.js";

// biome-ignore lint/suspicious/noExplicitAny: minimal Task stub for status-mapping tests; full Task type not needed.
function fakeTaskRow(overrides: Partial<{ id: string; status: string }> = {}): any {
  // Returns a minimal Task-shaped object suitable for the runner's
  // status-mapping logic. We don't import the full Task type because
  // the runner only reads `id`, `status`, `success`, `failure`,
  // `cancellation` — and reflectively only when present.
  return {
    id: overrides.id ?? "task-id-1",
    status: overrides.status ?? "running",
    metadata: {},
    agent: "w",
    brief: "b",
    origin: "workflow",
    createdAt: "2026-06-07T00:00:00.000Z",
    startedAt: "2026-06-07T00:00:00.000Z",
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
  return {
    catalog,
    tasks,
    getAgent,
    dispatch,
    get,
    hasInFlightForWorkflowNode,
    listInFlightForWorkflowNode,
    cancel,
  };
}

const NODE_VALIDATE_CTX = {
  workflowId: "20260101-deadbeef",
  workflowStatus: "running" as const,
};

const DISPATCH_OPTS_BASE = {
  workflowId: "20260101-deadbeef",
  nodeId: "deadbeef-cafe-4bab-89ab-cafebabe1234",
  spec: { agent: "w", brief: "b" } as unknown,
  nodeDir: "/tmp/node-dir",
};

describe("makeWorkerNodeRunner — validate", () => {
  it("accepts a minimal valid spec", async () => {
    const deps = stubDeps();
    const r = makeWorkerNodeRunner({ catalog: deps.catalog, tasks: deps.tasks });
    const result = await r.validate({ agent: "w", brief: "b" }, NODE_VALIDATE_CTX);
    expect(result).toEqual({ agent: "w", brief: "b" });
    expect(deps.getAgent).toHaveBeenCalledWith("w");
    await r.dispose();
  });

  it("preserves details + runtime when provided", async () => {
    const deps = stubDeps();
    const r = makeWorkerNodeRunner({ catalog: deps.catalog, tasks: deps.tasks });
    const result = await r.validate(
      { agent: "w", brief: "b", details: "long body", runtime: "copilot" },
      NODE_VALIDATE_CTX,
    );
    expect(result).toEqual({
      agent: "w",
      brief: "b",
      details: "long body",
      runtime: "copilot",
    });
    await r.dispose();
  });

  it("rejects non-object spec", async () => {
    const deps = stubDeps();
    const r = makeWorkerNodeRunner({ catalog: deps.catalog, tasks: deps.tasks });
    await expect(r.validate(null, NODE_VALIDATE_CTX)).rejects.toBeInstanceOf(
      WorkflowWorkerSpecError,
    );
    await expect(r.validate("string", NODE_VALIDATE_CTX)).rejects.toBeInstanceOf(
      WorkflowWorkerSpecError,
    );
    await expect(r.validate([], NODE_VALIDATE_CTX)).rejects.toBeInstanceOf(WorkflowWorkerSpecError);
    await r.dispose();
  });

  it("rejects missing / non-string agent", async () => {
    const deps = stubDeps();
    const r = makeWorkerNodeRunner({ catalog: deps.catalog, tasks: deps.tasks });
    await expect(r.validate({ brief: "b" }, NODE_VALIDATE_CTX)).rejects.toBeInstanceOf(
      WorkflowWorkerSpecError,
    );
    await expect(r.validate({ agent: "  ", brief: "b" }, NODE_VALIDATE_CTX)).rejects.toBeInstanceOf(
      WorkflowWorkerSpecError,
    );
    await r.dispose();
  });

  it("rejects multi-line brief", async () => {
    const deps = stubDeps();
    const r = makeWorkerNodeRunner({ catalog: deps.catalog, tasks: deps.tasks });
    await expect(
      r.validate({ agent: "w", brief: "line1\nline2" }, NODE_VALIDATE_CTX),
    ).rejects.toBeInstanceOf(WorkflowWorkerSpecError);
    await r.dispose();
  });

  it("throws AgentNotFoundError when catalog returns null", async () => {
    const deps = stubDeps({ agent: null });
    const r = makeWorkerNodeRunner({ catalog: deps.catalog, tasks: deps.tasks });
    await expect(
      r.validate({ agent: "missing", brief: "b" }, NODE_VALIDATE_CTX),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
    await r.dispose();
  });

  it("throws AgentResolutionFailedError when catalog throws", async () => {
    const deps = stubDeps({ getAgentThrows: new Error("catalog down") });
    const r = makeWorkerNodeRunner({ catalog: deps.catalog, tasks: deps.tasks });
    await expect(r.validate({ agent: "w", brief: "b" }, NODE_VALIDATE_CTX)).rejects.toBeInstanceOf(
      AgentResolutionFailedError,
    );
    await r.dispose();
  });
});

describe("makeWorkerNodeRunner — dispatch", () => {
  it("calls tasks.dispatch with origin='workflow' + canonical metadata + 2-key subprocessEnv", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: fakeTaskRow is intentionally minimal vs the full Task type.
    const deps = stubDeps({ dispatchReturn: fakeTaskRow({ id: "tid-7" }) as any });
    const r = makeWorkerNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      pollIntervalMs: 100_000, // never poll during this test
    });
    const result = await r.dispatch({
      ...DISPATCH_OPTS_BASE,
      onTerminal: () => {},
    });
    expect(deps.dispatch).toHaveBeenCalledWith({
      agent: "w",
      brief: "b",
      origin: "workflow",
      metadata: {
        workflowId: "20260101-deadbeef",
        workflowNodeId: "deadbeef-cafe-4bab-89ab-cafebabe1234",
      },
      // Worker tasks see the two workflow identity env keys
      // (`EMPLOKE_WORKFLOW_ID`, `EMPLOKE_NODE_ID`) but NOT
      // `EMPLOKE_WORKFLOW_DIR` — the per-workflow shared dir is
      // coord-only by design. Worker also does NOT pass `prompt`
      // (uses `@emploke/task`'s default framing).
      subprocessEnv: {
        EMPLOKE_WORKFLOW_ID: "20260101-deadbeef",
        EMPLOKE_NODE_ID: "deadbeef-cafe-4bab-89ab-cafebabe1234",
      },
    });
    expect(result).toBeUndefined();
    await r.dispose();
  });

  it("does NOT pass EMPLOKE_WORKFLOW_DIR (coord-only) or a prompt override", async () => {
    const deps = stubDeps();
    const r = makeWorkerNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      pollIntervalMs: 100_000,
    });
    await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal: () => {} });

    const calls = deps.dispatch.mock.calls as unknown as ReadonlyArray<
      readonly [Record<string, unknown>]
    >;
    const firstCall = calls[0]?.[0];
    expect(firstCall).toBeDefined();
    if (firstCall !== undefined) {
      // No prompt override — worker dispatch must NOT include the
      // key; the task pkg's default `TASK_FRAMING_PROMPT_COPILOT`
      // applies. (Conditional-spread style would otherwise
      // serialize `prompt: undefined`.)
      expect(Object.keys(firstCall)).not.toContain("prompt");
      // No coord-only env key.
      const env = (firstCall as { subprocessEnv?: Record<string, string> }).subprocessEnv;
      expect(env).toBeDefined();
      expect(env).not.toHaveProperty("EMPLOKE_WORKFLOW_DIR");
    }
    await r.dispose();
  });

  it("forwards details + runtime when present on the spec", async () => {
    const deps = stubDeps();
    const r = makeWorkerNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      pollIntervalMs: 100_000,
    });
    await r.dispatch({
      ...DISPATCH_OPTS_BASE,
      spec: { agent: "w", brief: "b", details: "d", runtime: "copilot" },
      onTerminal: () => {},
    });
    expect(deps.dispatch).toHaveBeenCalledWith({
      agent: "w",
      brief: "b",
      details: "d",
      runtime: "copilot",
      origin: "workflow",
      metadata: {
        workflowId: "20260101-deadbeef",
        workflowNodeId: "deadbeef-cafe-4bab-89ab-cafebabe1234",
      },
      // The injected env shape is the same two identity keys
      // regardless of spec.details / spec.runtime — those spec
      // fields don't influence the env bag.
      subprocessEnv: {
        EMPLOKE_WORKFLOW_ID: "20260101-deadbeef",
        EMPLOKE_NODE_ID: "deadbeef-cafe-4bab-89ab-cafebabe1234",
      },
    });
    await r.dispose();
  });
});

describe("makeWorkerNodeRunner — poll loop terminal mapping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps task.status='succeeded' → onTerminal({status:'succeeded'})", async () => {
    const deps = stubDeps({
      getReturn: fakeTaskRow({ status: "succeeded" }),
    });
    const onTerminal = vi.fn();
    const r = makeWorkerNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      pollIntervalMs: 100,
    });
    await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal });
    await vi.advanceTimersByTimeAsync(150);
    // Settle the microtask the interval callback queued.
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    const arg = onTerminal.mock.calls[0]?.[0];
    expect(arg.status).toBe("succeeded");
    await r.dispose();
  });

  it("maps task.status='failed' → onTerminal({status:'failed', reason})", async () => {
    const failure = { kind: "exited", exit_code: 1, message: "non-zero exit" };
    const deps = stubDeps({
      getReturn: { ...fakeTaskRow({ status: "failed" }), failure },
    });
    const onTerminal = vi.fn();
    const r = makeWorkerNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
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

  it("maps task.status='cancelled' → onTerminal({status:'cancelled', reason})", async () => {
    const cancellation = { kind: "user", message: "cancelled by user" };
    const deps = stubDeps({
      getReturn: { ...fakeTaskRow({ status: "cancelled" }), cancellation },
    });
    const onTerminal = vi.fn();
    const r = makeWorkerNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      pollIntervalMs: 100,
    });
    await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal });
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal.mock.calls[0]?.[0]).toEqual({
      status: "cancelled",
      reason: "cancelled by user",
    });
    await r.dispose();
  });

  it("falls back to a runner-default reason when cancellation.message is absent", async () => {
    const deps = stubDeps({
      getReturn: fakeTaskRow({ status: "cancelled" }),
    });
    const onTerminal = vi.fn();
    const r = makeWorkerNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      pollIntervalMs: 100,
    });
    await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal });
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal.mock.calls[0]?.[0]).toEqual({
      status: "cancelled",
      reason: "task cancelled (no reason recorded)",
    });
    await r.dispose();
  });

  it("maps tasks.get → null → onTerminal({status:'failed', reason:'task not found'})", async () => {
    const deps = stubDeps({ getReturn: null });
    const onTerminal = vi.fn();
    const r = makeWorkerNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
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

  it("running status does NOT fire onTerminal (poll continues)", async () => {
    const deps = stubDeps({ getReturn: fakeTaskRow({ status: "running" }) });
    const onTerminal = vi.fn();
    const r = makeWorkerNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      pollIntervalMs: 100,
    });
    await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal });
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).not.toHaveBeenCalled();
    expect(deps.get.mock.calls.length).toBeGreaterThanOrEqual(2);
    await r.dispose();
  });

  it("clears poll interval after firing onTerminal (no further polls)", async () => {
    const deps = stubDeps({
      getReturn: fakeTaskRow({ status: "succeeded" }),
    });
    const onTerminal = vi.fn();
    const r = makeWorkerNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      pollIntervalMs: 100,
    });
    await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal });
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterFirst = deps.get.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.get.mock.calls.length).toBe(callsAfterFirst);
    await r.dispose();
  });
});

describe("makeWorkerNodeRunner — poll error budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exhausts the error budget after maxPollErrors consecutive throws", async () => {
    const deps = stubDeps({ getThrows: new Error("transient boom") });
    const onTerminal = vi.fn();
    const r = makeWorkerNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      pollIntervalMs: 100,
      maxPollErrors: 3,
    });
    await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal });
    // Tick past three poll cycles.
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    const arg = onTerminal.mock.calls[0]?.[0];
    expect(arg.status).toBe("failed");
    expect(String(arg.reason)).toMatch(/tasks\.get exhausted/);
    expect(String(arg.reason)).toMatch(/transient boom/);
    await r.dispose();
  });

  it("resets error counter on a successful poll between errors", async () => {
    // Error → success → error → success — never reaches maxPollErrors.
    let n = 0;
    const get = vi.fn(async (_id: string) => {
      n += 1;
      if (n % 2 === 1) throw new Error("flaky");
      return fakeTaskRow({ status: "running" });
    });
    const deps = stubDeps();
    // biome-ignore lint/suspicious/noExplicitAny: test-only override of the stubbed facade.
    (deps.tasks as any).get = get;
    const onTerminal = vi.fn();
    const r = makeWorkerNodeRunner({
      catalog: deps.catalog,
      tasks: deps.tasks,
      pollIntervalMs: 100,
      maxPollErrors: 2,
    });
    await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal });
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).not.toHaveBeenCalled();
    await r.dispose();
  });
});

describe("makeWorkerNodeRunner — hasInFlightForNode + cancel + dispose", () => {
  it("hasInFlightForNode delegates to tasks.hasInFlightForWorkflowNode", async () => {
    const deps = stubDeps({ hasInFlightReturn: true });
    const r = makeWorkerNodeRunner({ catalog: deps.catalog, tasks: deps.tasks });
    const result = await r.hasInFlightForNode("deadbeef-cafe-4bab-89ab-cafebabe1234");
    expect(result).toBe(true);
    expect(deps.hasInFlightForWorkflowNode).toHaveBeenCalledWith(
      "deadbeef-cafe-4bab-89ab-cafebabe1234",
    );
    await r.dispose();
  });

  it("cancel reverse-looks-up via tasks.listInFlightForWorkflowNode and calls tasks.cancel for each", async () => {
    const deps = stubDeps({
      listInFlightReturn: [fakeTaskRow({ id: "t-a" }), fakeTaskRow({ id: "t-b" })],
    });
    const r = makeWorkerNodeRunner({ catalog: deps.catalog, tasks: deps.tasks });
    await r.cancel("deadbeef-cafe-4bab-89ab-cafebabe1234");
    expect(deps.listInFlightForWorkflowNode).toHaveBeenCalledWith(
      "deadbeef-cafe-4bab-89ab-cafebabe1234",
    );
    expect(deps.cancel).toHaveBeenCalledTimes(2);
    expect(deps.cancel).toHaveBeenCalledWith("t-a");
    expect(deps.cancel).toHaveBeenCalledWith("t-b");
    await r.dispose();
  });

  it("cancel survives tasks.cancel throwing on one task (best-effort, continues)", async () => {
    const deps = stubDeps({
      listInFlightReturn: [fakeTaskRow({ id: "t-a" }), fakeTaskRow({ id: "t-b" })],
    });
    // biome-ignore lint/suspicious/noExplicitAny: test-only override of the stubbed facade.
    (deps.tasks as any).cancel = vi.fn(async (id: string) => {
      if (id === "t-a") throw new Error("cancel boom");
    });
    const r = makeWorkerNodeRunner({ catalog: deps.catalog, tasks: deps.tasks });
    // Should NOT throw; the runner logs and continues.
    await r.cancel("deadbeef-cafe-4bab-89ab-cafebabe1234");
    // biome-ignore lint/suspicious/noExplicitAny: test-only access to the overridden mock.
    expect((deps.tasks as any).cancel).toHaveBeenCalledTimes(2);
    await r.dispose();
  });

  it("dispose() clears every armed interval", async () => {
    vi.useFakeTimers();
    try {
      const deps = stubDeps({ getReturn: fakeTaskRow({ status: "running" }) });
      const r = makeWorkerNodeRunner({
        catalog: deps.catalog,
        tasks: deps.tasks,
        pollIntervalMs: 100,
      });
      const onTerminal = vi.fn();
      await r.dispatch({ ...DISPATCH_OPTS_BASE, onTerminal });
      await r.dispatch({
        ...DISPATCH_OPTS_BASE,
        nodeId: "cafebabe-dead-4bee-89ab-feedbabe1234",
        onTerminal,
      });
      await vi.advanceTimersByTimeAsync(150);
      const callsBeforeDispose = deps.get.mock.calls.length;
      expect(callsBeforeDispose).toBeGreaterThanOrEqual(2);
      await r.dispose();
      // After dispose no further polls should fire.
      await vi.advanceTimersByTimeAsync(500);
      expect(deps.get.mock.calls.length).toBe(callsBeforeDispose);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("makeWorkerNodeRunner — exported constants + factory shape", () => {
  it("exposes default poll interval + max poll errors constants", () => {
    expect(DEFAULT_WORKER_POLL_INTERVAL_MS).toBe(2000);
    expect(DEFAULT_WORKER_MAX_POLL_ERRORS).toBe(3);
  });

  it("WorkflowWorkerSpecError sets the canonical .name for instanceof routing", async () => {
    const err = new WorkflowWorkerSpecError("bad spec");
    expect(err.name).toBe("WorkflowWorkerSpecError");
    expect(err.message).toBe("bad spec");
  });
});
