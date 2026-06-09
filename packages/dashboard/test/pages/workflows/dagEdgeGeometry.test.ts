import { describe, expect, it } from "vitest";
import type { WorkflowEdgeWire, WorkflowNodeWire } from "../../../src/api";
import {
  buildSlotMap,
  groupByPhase,
  projectEndpoints,
  type Rect,
  resolveEdges,
} from "../../../src/pages/workflows/dagEdgeGeometry";

/**
 * Unit tests for the DAG geometry helpers. These are pure functions
 * (no React, no DOM, no async), so the suite stays trivial and
 * focuses on the layout invariants the View layer depends on:
 *
 *   - phases are returned in ascending order
 *   - within a phase, nodes are sorted by `createdAt` ASC for a
 *     stable column index across poll re-renders
 *   - edges to / from unknown node ids are silently dropped
 *   - endpoint projection uses bottom-centre → top-centre per node
 *     rect, relative to the DAG container
 */

function makeNode(overrides: Partial<WorkflowNodeWire>): WorkflowNodeWire {
  return {
    id: "n-default",
    workflowId: "wf-1",
    status: "running",
    phase: 0,
    spec: { kind: "worker", agent: "emploke/dev", brief: "x" },
    createdAt: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("groupByPhase", () => {
  it("returns phases in ascending order even when input is shuffled", () => {
    const nodes = [
      makeNode({ id: "a", phase: 2 }),
      makeNode({ id: "b", phase: 0 }),
      makeNode({ id: "c", phase: 1 }),
    ];
    const phases = groupByPhase(nodes);
    expect(phases.map((p) => p.phase)).toEqual([0, 1, 2]);
  });

  it("within a phase, sorts nodes by createdAt ASC", () => {
    const nodes = [
      makeNode({ id: "later", phase: 0, createdAt: "2026-05-28T00:05:00.000Z" }),
      makeNode({ id: "earlier", phase: 0, createdAt: "2026-05-28T00:01:00.000Z" }),
    ];
    const phases = groupByPhase(nodes);
    expect(phases[0]?.nodes.map((n) => n.id)).toEqual(["earlier", "later"]);
  });

  it("returns an empty array when given no nodes", () => {
    expect(groupByPhase([])).toEqual([]);
  });
});

describe("buildSlotMap", () => {
  it("assigns row = phase and column = createdAt index within phase", () => {
    const phases = groupByPhase([
      makeNode({ id: "a", phase: 0, createdAt: "2026-05-28T00:01:00.000Z" }),
      makeNode({ id: "b", phase: 0, createdAt: "2026-05-28T00:02:00.000Z" }),
      makeNode({ id: "c", phase: 1, createdAt: "2026-05-28T00:03:00.000Z" }),
    ]);
    const slots = buildSlotMap(phases);
    expect(slots.get("a")).toEqual({ nodeId: "a", row: 0, column: 0 });
    expect(slots.get("b")).toEqual({ nodeId: "b", row: 0, column: 1 });
    expect(slots.get("c")).toEqual({ nodeId: "c", row: 1, column: 0 });
  });
});

describe("resolveEdges", () => {
  it("maps edges to fromRow / toRow and drops edges with unknown endpoints", () => {
    const phases = groupByPhase([makeNode({ id: "a", phase: 0 }), makeNode({ id: "b", phase: 1 })]);
    const slots = buildSlotMap(phases);
    const edges: WorkflowEdgeWire[] = [
      { from: "a", to: "b" },
      { from: "a", to: "missing" },
      { from: "missing", to: "b" },
    ];
    const segs = resolveEdges(edges, slots);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({
      id: "a->b",
      fromNodeId: "a",
      toNodeId: "b",
      fromRow: 0,
      toRow: 1,
    });
  });
});

describe("projectEndpoints", () => {
  it("uses bottom-centre of source and top-centre of destination", () => {
    const rects = new Map<string, Rect>([
      ["a", { left: 0, top: 0, width: 100, height: 40 }],
      ["b", { left: 200, top: 100, width: 80, height: 30 }],
    ]);
    const segs = [{ id: "a->b", fromNodeId: "a", toNodeId: "b", fromRow: 0, toRow: 1 }];
    const endpoints = projectEndpoints(segs, rects);
    expect(endpoints).toHaveLength(1);
    const e = endpoints[0]!;
    expect(e.x1).toBe(50);
    expect(e.y1).toBe(40);
    expect(e.x2).toBe(240);
    expect(e.y2).toBe(100);
  });

  it("skips segments whose endpoints haven't been measured yet", () => {
    const rects = new Map<string, Rect>([["a", { left: 0, top: 0, width: 10, height: 10 }]]);
    const segs = [{ id: "a->b", fromNodeId: "a", toNodeId: "b", fromRow: 0, toRow: 1 }];
    expect(projectEndpoints(segs, rects)).toEqual([]);
  });
});
