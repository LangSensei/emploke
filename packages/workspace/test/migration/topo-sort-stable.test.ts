import { describe, expect, it } from "vitest";
import { topoSort } from "../../src/migration/topo-sort.js";
import type { Migration } from "../../src/migration/types.js";

function m(pkg: string, fromVersion: number, dependsOn?: readonly string[]): Migration {
  return {
    pkg,
    fromVersion,
    toVersion: fromVersion + 1,
    schemaSQL: "",
    ...(dependsOn ? { dependsOn } : {}),
  };
}

describe("topoSort — stable ordering", () => {
  it("produces the same output across runs for the same input", () => {
    // Multi-pkg, multi-version pending set with cross-pkg deps. The
    // tie-breaker within a zero-indegree frontier is (pkg ASC,
    // fromVersion ASC) so the ordering is fully deterministic.
    const inputs = [
      m("b", 0),
      m("a", 0),
      m("c", 0),
      m("a", 1, ["c:1"]),
      m("b", 1, ["a:2"]),
      m("c", 1),
    ];

    const runs = Array.from({ length: 5 }, () => topoSort(inputs));
    const labels = runs.map((r) => r.map((mig) => `${mig.pkg}:${mig.toVersion}`));
    // Every run produces the exact same ordering.
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i]).toEqual(labels[0]);
    }
  });

  it("respects within-pkg version chains (vN+1 always after vN)", () => {
    const out = topoSort([m("x", 2), m("x", 0), m("x", 1)]);
    expect(out.map((mig) => `${mig.pkg}:${mig.toVersion}`)).toEqual(["x:1", "x:2", "x:3"]);
  });

  it("respects explicit cross-pkg dependsOn edges", () => {
    // task:4 depends on workflow:1. Even if registered first, the
    // sort must place workflow:1 before task:4.
    const out = topoSort([m("task", 3, ["workflow:1"]), m("workflow", 0)]);
    const labels = out.map((mig) => `${mig.pkg}:${mig.toVersion}`);
    const workflowIdx = labels.indexOf("workflow:1");
    const taskIdx = labels.indexOf("task:4");
    expect(workflowIdx).toBeLessThan(taskIdx);
  });
});
