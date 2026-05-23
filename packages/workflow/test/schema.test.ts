import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestWorkflowDb } from "../src/testing.js";

let handle: ReturnType<typeof openTestWorkflowDb>;

beforeEach(() => {
  handle = openTestWorkflowDb();
});

afterEach(() => {
  handle.close();
});

/**
 * Verify the 0000 migration creates the three tables with the
 * expected columns and indexes. Pure SQL introspection through
 * better-sqlite3.
 */
describe("workflows schema", () => {
  it("creates workflows, workflow_nodes, workflow_edges tables", () => {
    const rows = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain("workflows");
    expect(names).toContain("workflow_nodes");
    expect(names).toContain("workflow_edges");
  });

  it("workflows table has the documented columns", () => {
    const cols = handle.sqlite.prepare("PRAGMA table_info('workflows')").all() as {
      name: string;
      notnull: number;
    }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "archived_at",
        "brief",
        "created_at",
        "details",
        "id",
        "metadata",
        "outcome",
        "started_at",
        "status",
      ].sort(),
    );
  });

  it("workflow_nodes table has the documented columns", () => {
    const cols = handle.sqlite.prepare("PRAGMA table_info('workflow_nodes')").all() as {
      name: string;
    }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "created_at",
        "data",
        "ended_at",
        "id",
        "ready_at",
        "running_at",
        "spec",
        "status",
        "type",
        "workflow_id",
      ].sort(),
    );
  });

  it("workflow_edges table has the documented columns and composite PK", () => {
    const cols = handle.sqlite.prepare("PRAGMA table_info('workflow_edges')").all() as {
      name: string;
      pk: number;
    }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["from_node_id", "to_node_id", "workflow_id"].sort());
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pkCols.sort()).toEqual(["from_node_id", "to_node_id", "workflow_id"].sort());
  });

  it("creates the expected indexes", () => {
    const rows = handle.sqlite
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
      .all() as { name: string; tbl_name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain("workflow_nodes_workflow_idx");
    expect(names).toContain("workflow_nodes_status_idx");
    expect(names).toContain("workflow_edges_from_idx");
    expect(names).toContain("workflow_edges_to_idx");
  });

  it("writes the journal table __drizzle_migrations_workflow", () => {
    const rows = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__drizzle%'")
      .all() as { name: string }[];
    expect(rows.map((r) => r.name)).toContain("__drizzle_migrations_workflow");
  });
});
