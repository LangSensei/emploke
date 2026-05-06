import { describe, expect, it } from "vitest";
import { CycleDetected, MissingDependencies } from "../src/errors.js";
import { findDirectDependents, type GraphNode, resolveTopological } from "../src/graph.js";

const makeLookup = (nodes: GraphNode[]) => {
  const map = new Map(nodes.map((n) => [n.name, n]));
  return (name: string) => map.get(name);
};

describe("resolveTopological", () => {
  it("returns single root with no deps", () => {
    const r = resolveTopological(["a"], makeLookup([{ name: "a", dependencies: [] }]));
    expect(r.map((n) => n.name)).toEqual(["a"]);
  });

  it("orders deps before dependents", () => {
    const nodes: GraphNode[] = [
      { name: "a", dependencies: ["b"] },
      { name: "b", dependencies: ["c"] },
      { name: "c", dependencies: [] },
    ];
    const r = resolveTopological(["a"], makeLookup(nodes));
    expect(r.map((n) => n.name)).toEqual(["c", "b", "a"]);
  });

  it("de-duplicates shared dependencies", () => {
    const nodes: GraphNode[] = [
      { name: "a", dependencies: ["c"] },
      { name: "b", dependencies: ["c"] },
      { name: "c", dependencies: [] },
    ];
    const r = resolveTopological(["a", "b"], makeLookup(nodes));
    expect(r.map((n) => n.name)).toEqual(["c", "a", "b"]);
  });

  it("throws MissingDependencies when a referenced name is not in lookup", () => {
    const nodes: GraphNode[] = [{ name: "a", dependencies: ["ghost"] }];
    expect(() => resolveTopological(["a"], makeLookup(nodes))).toThrow(MissingDependencies);
  });

  it("throws CycleDetected for self-cycle", () => {
    const nodes: GraphNode[] = [{ name: "a", dependencies: ["a"] }];
    try {
      resolveTopological(["a"], makeLookup(nodes));
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CycleDetected);
      expect((e as CycleDetected).cycle).toEqual(["a", "a"]);
    }
  });

  it("throws CycleDetected for two-node cycle", () => {
    const nodes: GraphNode[] = [
      { name: "a", dependencies: ["b"] },
      { name: "b", dependencies: ["a"] },
    ];
    try {
      resolveTopological(["a"], makeLookup(nodes));
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CycleDetected);
      expect((e as CycleDetected).cycle).toEqual(["a", "b", "a"]);
    }
  });

  it("throws CycleDetected for longer cycle", () => {
    const nodes: GraphNode[] = [
      { name: "a", dependencies: ["b"] },
      { name: "b", dependencies: ["c"] },
      { name: "c", dependencies: ["a"] },
    ];
    expect(() => resolveTopological(["a"], makeLookup(nodes))).toThrow(CycleDetected);
  });

  it("handles diamond dependency", () => {
    const nodes: GraphNode[] = [
      { name: "top", dependencies: ["left", "right"] },
      { name: "left", dependencies: ["base"] },
      { name: "right", dependencies: ["base"] },
      { name: "base", dependencies: [] },
    ];
    const r = resolveTopological(["top"], makeLookup(nodes));
    const names = r.map((n) => n.name);
    expect(names).toContain("base");
    expect(names).toContain("top");
    // base must appear before left, right; left and right before top
    expect(names.indexOf("base")).toBeLessThan(names.indexOf("left"));
    expect(names.indexOf("base")).toBeLessThan(names.indexOf("right"));
    expect(names.indexOf("left")).toBeLessThan(names.indexOf("top"));
    expect(names.indexOf("right")).toBeLessThan(names.indexOf("top"));
    // base appears once, top once
    expect(names.filter((n) => n === "base").length).toBe(1);
    expect(names.filter((n) => n === "top").length).toBe(1);
  });
});

describe("findDirectDependents", () => {
  it("returns empty list when no one depends", () => {
    const nodes: GraphNode[] = [
      { name: "a", dependencies: [] },
      { name: "b", dependencies: [] },
    ];
    expect(findDirectDependents("a", nodes)).toHaveLength(0);
  });

  it("returns nodes that directly depend on target", () => {
    const nodes: GraphNode[] = [
      { name: "a", dependencies: ["target"] },
      { name: "b", dependencies: ["target", "other"] },
      { name: "c", dependencies: ["other"] },
    ];
    const r = findDirectDependents("target", nodes);
    expect(r.map((n) => n.name).sort()).toEqual(["a", "b"]);
  });
});
