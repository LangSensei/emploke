import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveWorkspace } from "../../src/api/http";
import {
  cancelWorkflow,
  createWorkflow,
  getWorkflow,
  getWorkflowDag,
  listWorkflows,
} from "../../src/api/workflows";

interface FetchCallSpy {
  url: string;
  init: RequestInit | undefined;
}

let calls: FetchCallSpy[] = [];

function installFetch(response: unknown, status = 200): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  setActiveWorkspace("ws-test-uuid");
});

afterEach(() => {
  setActiveWorkspace(null);
  vi.restoreAllMocks();
});

describe("listWorkflows — URL construction", () => {
  it("omits the status query when no filter is passed", async () => {
    installFetch([]);
    await listWorkflows();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/workspaces/ws-test-uuid/workflows");
  });

  it("encodes the status filter as ?status=<value>", async () => {
    installFetch([]);
    await listWorkflows({ status: "running" });
    expect(calls[0]?.url).toBe("/api/workspaces/ws-test-uuid/workflows?status=running");
  });

  it("encodes the workspace id (path) and threads through the prefix builder", async () => {
    setActiveWorkspace("ws with spaces");
    installFetch([]);
    await listWorkflows();
    expect(calls[0]?.url.startsWith("/api/workspaces/ws%20with%20spaces/workflows")).toBe(true);
  });
});

describe("getWorkflow / getWorkflowDag — URL construction", () => {
  it("encodes the workflow id in the path", async () => {
    installFetch({});
    await getWorkflow("wf with/slash");
    expect(calls[0]?.url).toBe("/api/workspaces/ws-test-uuid/workflows/wf%20with%2Fslash");
  });

  it("requests the /dag suffix for the DAG endpoint", async () => {
    installFetch({});
    await getWorkflowDag("wf-1");
    expect(calls[0]?.url).toBe("/api/workspaces/ws-test-uuid/workflows/wf-1/dag");
  });
});

describe("createWorkflow — POST body shape", () => {
  it("POSTs to /workflows with a JSON-serialised body", async () => {
    installFetch({ id: "wf-new" }, 201);
    await createWorkflow({
      brief: "Do the thing",
      details: "extra context",
      coordinatorAgent: "emploke/dev",
    });
    expect(calls[0]?.url).toBe("/api/workspaces/ws-test-uuid/workflows");
    expect(calls[0]?.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({
      brief: "Do the thing",
      details: "extra context",
      coordinatorAgent: "emploke/dev",
    });
  });
});

describe("cancelWorkflow — POST /cancel", () => {
  it("POSTs the v2.2 cancellation payload when message is empty", async () => {
    installFetch({ id: "wf-1" });
    await cancelWorkflow("wf-1", { cancellation: { kind: "user", message: "" } });
    expect(calls[0]?.url).toBe("/api/workspaces/ws-test-uuid/workflows/wf-1/cancel");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      cancellation: { kind: "user", message: "" },
    });
  });

  it("includes the message when one is provided", async () => {
    installFetch({ id: "wf-1" });
    await cancelWorkflow("wf-1", { cancellation: { kind: "user", message: "superseded" } });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      cancellation: { kind: "user", message: "superseded" },
    });
  });
});
