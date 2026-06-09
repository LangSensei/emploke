/**
 * `emploke workflow …` — per-subcommand tests covering the 5 verbs
 * (list / create / show / dag / cancel) shipped by the M2.3 CLI.
 *
 * Shape mirrors `schedule-patch.test.ts`: vi.spyOn the global
 * `fetch`, drive the command's pure function directly, assert on the
 * URL / method / body / exit code / stdout. Where the verb routes
 * through commander (`runCli`) it's documented inline.
 *
 * Each subcommand block covers:
 *  - happy path (200 → exit 0 with the expected stdout shape)
 *  - input validation where applicable (missing required arg → exit 2,
 *    no fetch)
 *  - server-error envelope (4xx with `error` + `code` → exit 4, typed
 *    code surfaces in stderr via `formatError`)
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  workflowAddEdge,
  workflowAddNode,
  workflowAddSubgraph,
  workflowCancel,
  workflowCancelNode,
  workflowCreate,
  workflowDag,
  workflowFinish,
  workflowList,
  workflowRemoveEdge,
  workflowRemoveNode,
  workflowReplaceSpec,
  workflowShow,
} from "../../src/commands/workflow.js";
import { runCli } from "../_helpers/run-cli.js";

const SERVER_URL = "http://stub.local";
const WSID = "ws-abc";
const WFID = "20260601-aaaaaaaa";

let home: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "emploke-cli-workflow-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

interface MockResponse {
  status: number;
  body: string;
  contentType?: string;
}

function stubFetchMulti(responses: readonly MockResponse[]): { calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const r = responses[i];
    i += 1;
    const rawBody = init?.body;
    let parsed: unknown;
    if (typeof rawBody === "string" && rawBody.length > 0) {
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = rawBody;
      }
    }
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: parsed,
    });
    if (r === undefined) {
      return new Response(`unexpected request #${i}: ${String(input)}`, { status: 500 });
    }
    return new Response(r.body === "" ? null : r.body, {
      status: r.status,
      headers: { "content-type": r.contentType ?? "application/json" },
    });
  });
  return { calls };
}

function commonOpts() {
  return { workspace: WSID, server: SERVER_URL, home };
}

const sampleHeader = {
  id: WFID,
  brief: "design the parser",
  coordinatorAgent: "emploke/coordinator",
  status: "running" as const,
  metadata: {},
  iterationCount: 1,
  createdAt: "2026-06-01T00:00:00.000Z",
  startedAt: "2026-06-01T00:00:01.000Z",
};

const cancelledHeader = {
  ...sampleHeader,
  status: "cancelled" as const,
  endedAt: "2026-06-01T00:05:00.000Z",
};

const LIST_URL = `${SERVER_URL}/api/workspaces/${WSID}/workflows`;
const CREATE_URL = `${SERVER_URL}/api/workspaces/${WSID}/workflows`;
const GET_URL = `${SERVER_URL}/api/workspaces/${WSID}/workflows/${WFID}`;
const DAG_URL = `${SERVER_URL}/api/workspaces/${WSID}/workflows/${WFID}/dag`;
const CANCEL_URL = `${SERVER_URL}/api/workspaces/${WSID}/workflows/${WFID}/cancel`;

// ─── list ──────────────────────────────────────────────────────────────

describe("workflowList — happy path", () => {
  it("GETs /workflows and renders a table by default", async () => {
    const { calls } = stubFetchMulti([
      {
        status: 200,
        body: JSON.stringify([sampleHeader, { ...sampleHeader, id: "wf-2", status: "succeeded" }]),
      },
    ]);
    const r = await workflowList(commonOpts());
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(LIST_URL);
    // Header row + 2 data rows.
    expect(r.stdout).toContain("ID");
    expect(r.stdout).toContain("BRIEF");
    expect(r.stdout).toContain("COORDINATORAGENT");
    expect(r.stdout).toContain("STATUS");
    expect(r.stdout).toContain(WFID);
    expect(r.stdout).toContain("wf-2");
    expect(r.stdout).toContain("running");
    expect(r.stdout).toContain("succeeded");
  });

  it("--json emits the array as formatted JSON", async () => {
    stubFetchMulti([{ status: 200, body: JSON.stringify([sampleHeader]) }]);
    const r = await workflowList({ ...commonOpts(), json: true });
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout ?? "") as ReadonlyArray<{ id: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe(WFID);
  });
});

describe("workflowList — server error envelope", () => {
  it("400 with typed code surfaces via formatError (exit 4)", async () => {
    stubFetchMulti([
      {
        status: 400,
        body: JSON.stringify({ error: "bad status", code: "WorkflowError" }),
      },
    ]);
    const r = await workflowList(commonOpts());
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/WorkflowError/);
    expect(r.stderr).toMatch(/HTTP 400/);
  });
});

// ─── create ────────────────────────────────────────────────────────────

describe("workflowCreate — happy path", () => {
  it("POSTs /workflows with the full body", async () => {
    const { calls } = stubFetchMulti([{ status: 201, body: JSON.stringify(sampleHeader) }]);
    const r = await workflowCreate({
      ...commonOpts(),
      brief: "design the parser",
      coordAgent: "emploke/coordinator",
      details: "Build a streaming JSON parser",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(CREATE_URL);
    expect(calls[0]?.body).toEqual({
      brief: "design the parser",
      coordinatorAgent: "emploke/coordinator",
      details: "Build a streaming JSON parser",
    });
    // Default output: formatted record of the created header.
    expect(r.stdout).toContain("ID");
    expect(r.stdout).toContain(WFID);
    expect(r.stdout).toContain("BRIEF");
  });

  it("omits --details from the body when absent", async () => {
    const { calls } = stubFetchMulti([{ status: 201, body: JSON.stringify(sampleHeader) }]);
    const r = await workflowCreate({
      ...commonOpts(),
      brief: "design the parser",
      coordAgent: "emploke/coordinator",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls[0]?.body).toEqual({
      brief: "design the parser",
      coordinatorAgent: "emploke/coordinator",
    });
  });

  it("--json emits the header as formatted JSON", async () => {
    stubFetchMulti([{ status: 201, body: JSON.stringify(sampleHeader) }]);
    const r = await workflowCreate({
      ...commonOpts(),
      brief: "design the parser",
      coordAgent: "emploke/coordinator",
      json: true,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout ?? "") as { id: string };
    expect(parsed.id).toBe(WFID);
  });
});

describe("workflowCreate — validation (no fetch)", () => {
  it("missing --brief → exit 2", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowCreate({
      ...commonOpts(),
      brief: "",
      coordAgent: "emploke/coordinator",
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--brief/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("missing --coord-agent → exit 2", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowCreate({ ...commonOpts(), brief: "do thing", coordAgent: "" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--coord-agent/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("whitespace-only --brief → exit 2", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowCreate({
      ...commonOpts(),
      brief: "   ",
      coordAgent: "emploke/coordinator",
    });
    expect(r.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("workflowCreate — server error envelope", () => {
  it("400 ValidationError surfaces via formatError (exit 4)", async () => {
    stubFetchMulti([
      {
        status: 400,
        body: JSON.stringify({
          error: "coordinatorAgent must declare emploke/coordinator",
          code: "CoordinatorAgentInvalidError",
        }),
      },
    ]);
    const r = await workflowCreate({
      ...commonOpts(),
      brief: "do thing",
      coordAgent: "emploke/dev",
    });
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/CoordinatorAgentInvalidError/);
    expect(r.stderr).toMatch(/HTTP 400/);
  });
});

// ─── show ──────────────────────────────────────────────────────────────

describe("workflowShow — happy path", () => {
  it("GETs /workflows/:wfid and formats the header as a record", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleHeader) }]);
    const r = await workflowShow({ ...commonOpts(), wfid: WFID });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(GET_URL);
    expect(r.stdout).toContain(WFID);
    expect(r.stdout).toContain("COORDINATORAGENT");
    expect(r.stdout).toContain("emploke/coordinator");
  });

  it("--json emits the header as formatted JSON", async () => {
    stubFetchMulti([{ status: 200, body: JSON.stringify(sampleHeader) }]);
    const r = await workflowShow({ ...commonOpts(), wfid: WFID, json: true });
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout ?? "") as { id: string };
    expect(parsed.id).toBe(WFID);
  });
});

describe("workflowShow — validation (no fetch)", () => {
  it("empty --wfid → exit 2", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowShow({ ...commonOpts(), wfid: "" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--wfid/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("workflowShow — server error envelope", () => {
  it("404 WorkflowNotFoundError surfaces via formatError (exit 4)", async () => {
    stubFetchMulti([
      {
        status: 404,
        body: JSON.stringify({
          error: `workflow "${WFID}" not found`,
          code: "WorkflowNotFoundError",
        }),
      },
    ]);
    const r = await workflowShow({ ...commonOpts(), wfid: WFID });
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/WorkflowNotFoundError/);
    expect(r.stderr).toMatch(/HTTP 404/);
  });
});

// ─── dag ───────────────────────────────────────────────────────────────

const sampleDag = {
  workflow: sampleHeader,
  nodes: [
    {
      id: "node-coord-1",
      workflowId: WFID,
      phase: 0,
      status: "succeeded",
      spec: { kind: "coordinator", agent: "emploke/coordinator" },
      createdAt: "2026-06-01T00:00:00.000Z",
      endedAt: "2026-06-01T00:00:10.000Z",
    },
    {
      id: "node-task-1",
      workflowId: WFID,
      phase: 1,
      status: "running",
      spec: {
        kind: "task",
        agent: "emploke/dev",
        brief: "implement parser",
      },
      createdAt: "2026-06-01T00:00:11.000Z",
      runningAt: "2026-06-01T00:00:12.000Z",
    },
  ],
  edges: [{ from: "node-coord-1", to: "node-task-1" }],
};

describe("workflowDag — happy path", () => {
  it("GETs /workflows/:wfid/dag and renders nodes + edges", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleDag) }]);
    const r = await workflowDag({ ...commonOpts(), wfid: WFID });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(DAG_URL);
    // Node table headers + one row per node.
    expect(r.stdout).toContain("PHASE");
    expect(r.stdout).toContain("NODEID");
    expect(r.stdout).toContain("KIND");
    expect(r.stdout).toContain("AGENT");
    expect(r.stdout).toContain("node-coord-1");
    expect(r.stdout).toContain("node-task-1");
    expect(r.stdout).toContain("emploke/coordinator");
    expect(r.stdout).toContain("emploke/dev");
    // Edges section.
    expect(r.stdout).toContain("edges:");
    expect(r.stdout).toContain("node-coord-1 → node-task-1");
  });

  it("zero edges → '(no edges)' placeholder", async () => {
    const dagNoEdges = { ...sampleDag, edges: [] };
    stubFetchMulti([{ status: 200, body: JSON.stringify(dagNoEdges) }]);
    const r = await workflowDag({ ...commonOpts(), wfid: WFID });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("(no edges)");
  });

  it("--json emits the full DAG snapshot as formatted JSON", async () => {
    stubFetchMulti([{ status: 200, body: JSON.stringify(sampleDag) }]);
    const r = await workflowDag({ ...commonOpts(), wfid: WFID, json: true });
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout ?? "") as {
      workflow: { id: string };
      nodes: ReadonlyArray<unknown>;
      edges: ReadonlyArray<unknown>;
    };
    expect(parsed.workflow.id).toBe(WFID);
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.edges).toHaveLength(1);
  });
});

describe("workflowDag — validation (no fetch)", () => {
  it("empty --wfid → exit 2", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowDag({ ...commonOpts(), wfid: "" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--wfid/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("workflowDag — server error envelope", () => {
  it("404 WorkflowNotFoundError surfaces via formatError (exit 4)", async () => {
    stubFetchMulti([
      {
        status: 404,
        body: JSON.stringify({
          error: `workflow "${WFID}" not found`,
          code: "WorkflowNotFoundError",
        }),
      },
    ]);
    const r = await workflowDag({ ...commonOpts(), wfid: WFID });
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/WorkflowNotFoundError/);
  });
});

// ─── cancel ────────────────────────────────────────────────────────────

describe("workflowCancel — happy path", () => {
  it("POSTs /workflows/:wfid/cancel with cancellation payload body (v2.2)", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(cancelledHeader) }]);
    const r = await workflowCancel({ ...commonOpts(), wfid: WFID });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(CANCEL_URL);
    // v2.2 always sends a body; --message omitted → empty string.
    expect(calls[0]?.body).toEqual({
      cancellation: { kind: "user", message: "" },
    });
    expect(r.stdout).toContain(`workflow ${WFID} cancelled`);
    expect(r.stdout).toContain("STATUS");
    expect(r.stdout).toContain("cancelled");
  });

  it("--message is sent on the wire as cancellation.message (v2.2)", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(cancelledHeader) }]);
    const r = await workflowCancel({ ...commonOpts(), wfid: WFID, message: "user pressed stop" });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      cancellation: { kind: "user", message: "user pressed stop" },
    });
  });

  it("--kind=user is accepted (the only kind v2.2 emits)", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(cancelledHeader) }]);
    const r = await workflowCancel({ ...commonOpts(), wfid: WFID, kind: "user", message: "stop" });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls[0]?.body).toEqual({
      cancellation: { kind: "user", message: "stop" },
    });
  });

  it("--json emits the post-cancel header as formatted JSON (no confirmation line)", async () => {
    stubFetchMulti([{ status: 200, body: JSON.stringify(cancelledHeader) }]);
    const r = await workflowCancel({ ...commonOpts(), wfid: WFID, json: true });
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout ?? "") as { id: string; status: string };
    expect(parsed.id).toBe(WFID);
    expect(parsed.status).toBe("cancelled");
    // Confirmation prose is suppressed in JSON mode to keep the
    // output a clean parseable object.
    expect(r.stdout).not.toContain(`workflow ${WFID} cancelled`);
  });
});

describe("workflowCancel — validation (no fetch)", () => {
  it("empty --wfid → exit 2", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowCancel({ ...commonOpts(), wfid: "" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--wfid/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("--kind other than 'user' → exit 2", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowCancel({ ...commonOpts(), wfid: WFID, kind: "cascade" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--kind/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("workflowCancel — server error envelope", () => {
  it("409 InvalidTransition surfaces via formatError (exit 4)", async () => {
    stubFetchMulti([
      {
        status: 409,
        body: JSON.stringify({
          error: "workflow already terminal",
          code: "InvalidTransition",
        }),
      },
    ]);
    const r = await workflowCancel({ ...commonOpts(), wfid: WFID });
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/InvalidTransition/);
    expect(r.stderr).toMatch(/HTTP 409/);
  });
});

// ─── commander wiring (argv → action) ──────────────────────────────────

describe("`emploke workflow …` commander wiring (argv → action)", () => {
  function env(): Record<string, string | undefined> {
    return {
      EMPLOKE_HOME: home,
      EMPLOKE_SERVER: SERVER_URL,
      EMPLOKE_WORKSPACE: undefined,
    };
  }

  it("`workflow list --workspace …` routes through commander to a GET", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify([sampleHeader]) }]);
    const r = await runCli(["workflow", "list", "--workspace", WSID], env());
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(LIST_URL);
  });

  it("`workflow create --brief --coord-agent` routes through commander to a POST with mapped body", async () => {
    const { calls } = stubFetchMulti([{ status: 201, body: JSON.stringify(sampleHeader) }]);
    const r = await runCli(
      [
        "workflow",
        "create",
        "--workspace",
        WSID,
        "--brief",
        "design the parser",
        "--coord-agent",
        "emploke/coordinator",
      ],
      env(),
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      brief: "design the parser",
      coordinatorAgent: "emploke/coordinator",
    });
  });

  it("`workflow cancel --wfid --message` routes through commander; --message is sent on the wire", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(cancelledHeader) }]);
    const r = await runCli(
      ["workflow", "cancel", "--workspace", WSID, "--wfid", WFID, "--message", "user pressed stop"],
      env(),
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(CANCEL_URL);
    expect(calls[0]?.body).toEqual({
      cancellation: { kind: "user", message: "user pressed stop" },
    });
  });
});

// ─── M2.5 coord-callback mutation commands ───────────────────────────

const NID = "20260601-bbbbbbbb";
const NID2 = "20260601-cccccccc";
const NODES_URL = `${SERVER_URL}/api/workspaces/${WSID}/workflows/${WFID}/nodes`;
const EDGES_URL = `${SERVER_URL}/api/workspaces/${WSID}/workflows/${WFID}/edges`;
const SUBGRAPH_URL = `${SERVER_URL}/api/workspaces/${WSID}/workflows/${WFID}/subgraph`;
const FINISH_URL = `${SERVER_URL}/api/workspaces/${WSID}/workflows/${WFID}/finish`;
const CANCEL_NODE_URL = `${SERVER_URL}/api/workspaces/${WSID}/workflows/${WFID}/nodes/${NID}/cancel`;
const REMOVE_NODE_URL = `${SERVER_URL}/api/workspaces/${WSID}/workflows/${WFID}/nodes/${NID}`;
const REMOVE_EDGE_URL = `${SERVER_URL}/api/workspaces/${WSID}/workflows/${WFID}/edges/${NID}/${NID2}`;
const REPLACE_SPEC_URL = `${SERVER_URL}/api/workspaces/${WSID}/workflows/${WFID}/nodes/${NID}/spec`;

const sampleNode = {
  id: NID,
  workflowId: WFID,
  phase: 2,
  status: "not_started" as const,
  spec: { kind: "task" as const, agent: "writer", brief: "thing" },
  createdAt: "2026-06-01T00:00:00.000Z",
};

async function writeSpec(payload: unknown): Promise<string> {
  const filePath = path.join(home, `spec-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(filePath, JSON.stringify(payload), "utf8");
  return filePath;
}

// ─── add-node ─────────────────────────────────────────────────────────

describe("workflowAddNode", () => {
  it("POSTs /nodes with kind + spec + parents from --spec-file and --parents", async () => {
    const specFile = await writeSpec({ agent: "writer", brief: "draft" });
    const { calls } = stubFetchMulti([
      { status: 200, body: JSON.stringify({ nodeId: NID, phase: 2 }) },
    ]);
    const r = await workflowAddNode({
      ...commonOpts(),
      wfid: WFID,
      kind: "worker",
      specFile,
      parents: "p1,p2",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(NODES_URL);
    expect(calls[0]?.body).toEqual({
      kind: "worker",
      spec: { agent: "writer", brief: "draft" },
      parents: ["p1", "p2"],
    });
  });

  it("rejects unknown --kind with exit 2, no fetch", async () => {
    const specFile = await writeSpec({});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowAddNode({
      ...commonOpts(),
      wfid: WFID,
      kind: "human",
      specFile,
    });
    expect(r.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects unreadable --spec-file with exit 2, no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowAddNode({
      ...commonOpts(),
      wfid: WFID,
      kind: "worker",
      specFile: path.join(home, "does-not-exist.json"),
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--spec-file read failed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects --spec-file with malformed JSON with exit 2, no fetch", async () => {
    const badPath = path.join(home, "bad.json");
    await writeFile(badPath, "{not json", "utf8");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowAddNode({
      ...commonOpts(),
      wfid: WFID,
      kind: "worker",
      specFile: badPath,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/JSON parse error/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("server 403 surfaces typed code via formatError (exit 4)", async () => {
    const specFile = await writeSpec({});
    stubFetchMulti([
      {
        status: 403,
        body: JSON.stringify({
          error: "denied",
          code: "WorkflowMutationUnauthorizedError",
        }),
      },
    ]);
    const r = await workflowAddNode({
      ...commonOpts(),
      wfid: WFID,
      kind: "worker",
      specFile,
      parents: "p1",
    });
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("WorkflowMutationUnauthorizedError");
  });
});

// ─── add-edge ─────────────────────────────────────────────────────────

describe("workflowAddEdge", () => {
  it("POSTs /edges with {fromNodeId, toNodeId} from --from / --to", async () => {
    const { calls } = stubFetchMulti([
      { status: 200, body: JSON.stringify({ fromNodeId: NID, toNodeId: NID2 }) },
    ]);
    const r = await workflowAddEdge({
      ...commonOpts(),
      wfid: WFID,
      from: NID,
      to: NID2,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(EDGES_URL);
    expect(calls[0]?.body).toEqual({ fromNodeId: NID, toNodeId: NID2 });
  });

  it("rejects missing --to with exit 2, no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowAddEdge({
      ...commonOpts(),
      wfid: WFID,
      from: NID,
      to: "",
    });
    expect(r.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── add-subgraph ─────────────────────────────────────────────────────

describe("workflowAddSubgraph", () => {
  it("POSTs /subgraph with the payload read from --spec-file", async () => {
    const payload = {
      nodes: [{ tempId: "t1", kind: "worker", spec: {} }],
      edges: [{ from: { nodeId: NID }, to: { tempId: "t1" } }],
    };
    const specFile = await writeSpec(payload);
    const { calls } = stubFetchMulti([
      {
        status: 200,
        body: JSON.stringify({
          insertedNodes: [{ tempId: "t1", nodeId: NID2, phase: 3 }],
        }),
      },
    ]);
    const r = await workflowAddSubgraph({ ...commonOpts(), wfid: WFID, specFile });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(SUBGRAPH_URL);
    expect(calls[0]?.body).toEqual(payload);
    expect(r.stdout).toContain("t1");
    expect(r.stdout).toContain(NID2);
  });

  it("rejects --spec-file that isn't an object with nodes+edges arrays", async () => {
    const specFile = await writeSpec(["wrong shape"]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowAddSubgraph({ ...commonOpts(), wfid: WFID, specFile });
    expect(r.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── remove-node ──────────────────────────────────────────────────────

describe("workflowRemoveNode", () => {
  it("DELETEs /nodes/:nid and exits 0 on 204", async () => {
    const { calls } = stubFetchMulti([{ status: 204, body: "" }]);
    const r = await workflowRemoveNode({ ...commonOpts(), wfid: WFID, nid: NID });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(REMOVE_NODE_URL);
  });

  it("surfaces 409 WorkflowRemoveNodeOrphansChildError via exit 4", async () => {
    stubFetchMulti([
      {
        status: 409,
        body: JSON.stringify({
          error: "orphan",
          code: "WorkflowRemoveNodeOrphansChildError",
        }),
      },
    ]);
    const r = await workflowRemoveNode({ ...commonOpts(), wfid: WFID, nid: NID });
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("WorkflowRemoveNodeOrphansChildError");
  });
});

// ─── remove-edge ──────────────────────────────────────────────────────

describe("workflowRemoveEdge", () => {
  it("DELETEs /edges/:from/:to and exits 0 on 204", async () => {
    const { calls } = stubFetchMulti([{ status: 204, body: "" }]);
    const r = await workflowRemoveEdge({
      ...commonOpts(),
      wfid: WFID,
      from: NID,
      to: NID2,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(REMOVE_EDGE_URL);
  });

  it("rejects missing --from with exit 2, no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowRemoveEdge({
      ...commonOpts(),
      wfid: WFID,
      from: "",
      to: NID2,
    });
    expect(r.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── replace-spec ─────────────────────────────────────────────────────

describe("workflowReplaceSpec", () => {
  it("PATCHes /nodes/:nid/spec with {newSpec} from --spec-file", async () => {
    const specFile = await writeSpec({ agent: "writer", brief: "rev" });
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleNode) }]);
    const r = await workflowReplaceSpec({
      ...commonOpts(),
      wfid: WFID,
      nid: NID,
      specFile,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe(REPLACE_SPEC_URL);
    expect(calls[0]?.body).toEqual({ newSpec: { agent: "writer", brief: "rev" } });
  });

  it("rejects missing --spec-file with exit 2", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowReplaceSpec({
      ...commonOpts(),
      wfid: WFID,
      nid: NID,
      specFile: "",
    });
    expect(r.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── cancel-node ──────────────────────────────────────────────────────

describe("workflowCancelNode", () => {
  it("POSTs /nodes/:nid/cancel and renders the post-cancel node", async () => {
    const cancelled = { ...sampleNode, status: "cancelled" as const };
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(cancelled) }]);
    const r = await workflowCancelNode({ ...commonOpts(), wfid: WFID, nid: NID });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(CANCEL_NODE_URL);
    expect(r.stdout).toContain("cancelled");
  });

  it("server 409 (coord-kind target) surfaces typed code via exit 4", async () => {
    stubFetchMulti([
      {
        status: 409,
        body: JSON.stringify({ error: "not mutable", code: "WorkflowNodeNotMutableError" }),
      },
    ]);
    const r = await workflowCancelNode({ ...commonOpts(), wfid: WFID, nid: NID });
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("WorkflowNodeNotMutableError");
  });
});

// ─── finish ───────────────────────────────────────────────────────────

describe("workflowFinish", () => {
  it("POSTs /finish with {outcome:'succeeded', success:{output:null}} when --summary omitted", async () => {
    const succeededHeader = {
      ...sampleHeader,
      status: "succeeded" as const,
      endedAt: "2026-06-01T01:00:00.000Z",
    };
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(succeededHeader) }]);
    const r = await workflowFinish({
      ...commonOpts(),
      wfid: WFID,
      outcome: "succeeded",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(FINISH_URL);
    expect(calls[0]?.body).toEqual({ outcome: "succeeded", success: { output: null } });
    expect(r.stdout).toContain("succeeded");
  });

  it("forwards --summary into success.output (v2.2)", async () => {
    const succeededHeader = {
      ...sampleHeader,
      status: "succeeded" as const,
      endedAt: "2026-06-01T01:00:00.000Z",
    };
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(succeededHeader) }]);
    const r = await workflowFinish({
      ...commonOpts(),
      wfid: WFID,
      outcome: "succeeded",
      summary: "All sub-runs green.",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls[0]?.body).toEqual({
      outcome: "succeeded",
      success: { output: "All sub-runs green." },
    });
  });

  it("forwards --message into failure.message when outcome=failed", async () => {
    const failedHeader = {
      ...sampleHeader,
      status: "failed" as const,
      endedAt: "2026-06-01T01:00:00.000Z",
    };
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(failedHeader) }]);
    const r = await workflowFinish({
      ...commonOpts(),
      wfid: WFID,
      outcome: "failed",
      message: "budget exhausted",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls[0]?.body).toEqual({
      outcome: "failed",
      failure: { kind: "coord", message: "budget exhausted" },
    });
  });

  it("rejects --outcome=failed without --message with exit 2", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowFinish({
      ...commonOpts(),
      wfid: WFID,
      outcome: "failed",
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--message is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects --summary with --outcome=failed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowFinish({
      ...commonOpts(),
      wfid: WFID,
      outcome: "failed",
      summary: "x",
      message: "y",
    });
    expect(r.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects --message with --outcome=succeeded", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowFinish({
      ...commonOpts(),
      wfid: WFID,
      outcome: "succeeded",
      message: "x",
    });
    expect(r.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects --outcome=cancelled with exit 2, no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await workflowFinish({
      ...commonOpts(),
      wfid: WFID,
      outcome: "cancelled",
    });
    expect(r.exitCode).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
