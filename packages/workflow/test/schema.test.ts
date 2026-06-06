import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestWorkflowDb } from "../src/testing.js";

/**
 * v1.0.0 schema smoke test. Verifies the 0001_v1_recreate migration
 * DROPs the v0.6.0 tables (created by 0000_initial) and recreates
 * the 3 tables with the v1 column set + the 7 indexes called out in
 * `packages/workflow/SPEC.md` §"Table 1/2/3".
 *
 * The migration runner applies 0000 + 0001 in order; the net effect
 * on a fresh DB is the v1.0.0 schema (the DROPs are no-ops on a
 * fresh DB because v0.6.0 tables are recreated by 0000 first, then
 * dropped by 0001 — and the test only sees the v1 final state).
 */

let handle: ReturnType<typeof openTestWorkflowDb>;

beforeEach(() => {
  handle = openTestWorkflowDb();
});

afterEach(() => {
  handle.close();
});

describe("workflows schema (v1.0.0)", () => {
  it("creates workflows, workflow_nodes, workflow_edges tables", () => {
    const rows = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain("workflows");
    expect(names).toContain("workflow_nodes");
    expect(names).toContain("workflow_edges");
  });

  it("workflows table has the v1.0.0 column set", () => {
    const cols = handle.sqlite.prepare("PRAGMA table_info('workflows')").all() as {
      name: string;
      notnull: number;
    }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "brief",
        "coordinator_agent",
        "created_at",
        "details",
        "ended_at",
        "id",
        "metadata",
        "started_at",
        "status",
      ].sort(),
    );
    // v0.6.0's `outcome` and `archived_at` MUST be gone.
    expect(names).not.toContain("outcome");
    expect(names).not.toContain("archived_at");
    // `coordinator_agent` must be NOT NULL (D14).
    const coordCol = cols.find((c) => c.name === "coordinator_agent");
    expect(coordCol?.notnull).toBe(1);
  });

  it("workflow_nodes table has the v1.0.0 column set", () => {
    const cols = handle.sqlite.prepare("PRAGMA table_info('workflow_nodes')").all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "created_at",
        "ended_at",
        "id",
        "kind",
        "phase",
        "ready_at",
        "running_at",
        "spec_json",
        "status",
        "workflow_id",
      ].sort(),
    );
    // v0.6.0's `type` / `spec` / `data` MUST be gone.
    expect(names).not.toContain("type");
    expect(names).not.toContain("spec");
    expect(names).not.toContain("data");
    // `kind` / `spec_json` MUST have no DEFAULT (D10).
    const kind = cols.find((c) => c.name === "kind");
    const spec = cols.find((c) => c.name === "spec_json");
    expect(kind?.notnull).toBe(1);
    expect(kind?.dflt_value).toBeNull();
    expect(spec?.notnull).toBe(1);
    expect(spec?.dflt_value).toBeNull();
    // `phase` is INTEGER NN.
    const phase = cols.find((c) => c.name === "phase");
    expect(phase?.notnull).toBe(1);
    expect(phase?.type.toUpperCase()).toBe("INTEGER");
  });

  it("workflow_edges table is unchanged from v0.6.0", () => {
    const cols = handle.sqlite.prepare("PRAGMA table_info('workflow_edges')").all() as {
      name: string;
      pk: number;
    }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["from_node_id", "to_node_id", "workflow_id"].sort());
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pkCols.sort()).toEqual(["from_node_id", "to_node_id", "workflow_id"].sort());
  });

  it("creates the v1.0.0 indexes", () => {
    const rows = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    // workflows
    expect(names).toContain("workflows_status_idx");
    expect(names).toContain("workflows_coordinator_agent_idx");
    // workflow_nodes — composite phase index is NEW in v1
    expect(names).toContain("workflow_nodes_workflow_idx");
    expect(names).toContain("workflow_nodes_status_idx");
    expect(names).toContain("workflow_nodes_phase_idx");
    // workflow_edges (unchanged)
    expect(names).toContain("workflow_edges_from_idx");
    expect(names).toContain("workflow_edges_to_idx");
  });

  it("uses the per-pkg journal table __drizzle_migrations_workflow", () => {
    const rows = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__drizzle%'")
      .all() as { name: string }[];
    expect(rows.map((r) => r.name)).toContain("__drizzle_migrations_workflow");
  });
});
