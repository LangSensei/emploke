import { describe, expect, it } from "vitest";
import {
  MigrationCycleError,
  MigrationDependencyMissingError,
} from "../../src/migration/errors.js";
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

describe("topoSort — cycle detection", () => {
  it("throws MigrationCycleError when two migrations form a dependency cycle", () => {
    // a depends on b, b depends on a — neither can be placed first.
    const inputs = [m("a", 0, ["b:1"]), m("b", 0, ["a:1"])];
    expect(() => topoSort(inputs)).toThrow(MigrationCycleError);
  });

  it("throws MigrationCycleError when a migration self-references", () => {
    expect(() => topoSort([m("a", 0, ["a:1"])])).toThrow(MigrationCycleError);
  });

  it("throws MigrationCycleError on a 3-node cycle", () => {
    // a → b → c → a
    const inputs = [m("a", 0, ["c:1"]), m("b", 0, ["a:1"]), m("c", 0, ["b:1"])];
    expect(() => topoSort(inputs)).toThrow(MigrationCycleError);
  });

  it("throws MigrationDependencyMissingError when dependsOn references an unknown pending migration", () => {
    // task:2 says it depends on workflow:1, but workflow:1 isn't in
    // the pending set. Authors should not silently get bypassed.
    expect(() => topoSort([m("task", 1, ["workflow:1"])])).toThrow(MigrationDependencyMissingError);
  });
});
