import type { AgentEntry } from "@emploke/catalog";
import { describe, expect, it } from "vitest";
import type { TaskRecord } from "../src/api";
import {
  agentDetailUrl,
  computeAgentRuntimeViews,
  splitFqn,
} from "../src/pages/Runtime/agentRuntime";

function makeAgent(fqn: string): AgentEntry {
  return {
    agent: { fqn, scope: fqn.split("/")[0], short: fqn.split("/")[1], version: "0.0.0" },
  } as unknown as AgentEntry;
}

function makeTask(agent: string, status: TaskRecord["status"]): TaskRecord {
  return {
    id: `t-${Math.random()}`,
    agent,
    status,
    brief: "",
    details: "",
    origin: "cli",
    metadata: {},
    createdAt: "2026-05-23T00:00:00Z",
  } as unknown as TaskRecord;
}

describe("computeAgentRuntimeViews", () => {
  it("classifies agents with at least one running task as 'running'", () => {
    const agents = [makeAgent("emploke/dev"), makeAgent("emploke/qa")];
    const tasks = [
      makeTask("emploke/dev", "running"),
      makeTask("emploke/dev", "succeeded"),
      makeTask("emploke/qa", "succeeded"),
    ];
    const views = computeAgentRuntimeViews(agents, tasks);
    const dev = views.find((v) => v.entry.agent.fqn === "emploke/dev")!;
    const qa = views.find((v) => v.entry.agent.fqn === "emploke/qa")!;
    expect(dev.status).toBe("running");
    expect(dev.runningTasks).toBe(1);
    expect(dev.totalTasks7d).toBe(2);
    expect(qa.status).toBe("idle");
    expect(qa.runningTasks).toBe(0);
    expect(qa.totalTasks7d).toBe(1);
  });

  it("returns idle with zero counts for an agent with no tasks", () => {
    const views = computeAgentRuntimeViews([makeAgent("a/b")], []);
    expect(views).toHaveLength(1);
    expect(views[0].status).toBe("idle");
    expect(views[0].runningTasks).toBe(0);
    expect(views[0].totalTasks7d).toBe(0);
  });

  it("ignores tasks whose agent isn't in the catalog list", () => {
    const views = computeAgentRuntimeViews(
      [makeAgent("a/b")],
      [makeTask("ghost/agent", "running")],
    );
    expect(views).toHaveLength(1);
    expect(views[0].status).toBe("idle");
  });
});

describe("splitFqn", () => {
  it("splits a well-formed fqn", () => {
    expect(splitFqn("emploke/dev")).toEqual({ scope: "emploke", short: "dev" });
  });
  it("returns null for input without a slash", () => {
    expect(splitFqn("nope")).toBeNull();
  });
  it("returns null for input with multiple slashes", () => {
    expect(splitFqn("a/b/c")).toBeNull();
  });
});

describe("agentDetailUrl", () => {
  it("keeps scope and short as two distinct path segments and lands on overview", () => {
    expect(agentDetailUrl("ws-1", "emploke", "dev")).toBe(
      "/workspaces/ws-1/runtime/agents/emploke/dev/overview",
    );
  });
  it("encodes special characters in wsId/scope/short", () => {
    expect(agentDetailUrl("ws 1", "a b", "c d")).toBe(
      "/workspaces/ws%201/runtime/agents/a%20b/c%20d/overview",
    );
  });
});
