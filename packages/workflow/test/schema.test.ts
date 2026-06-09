import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestWorkflowDb } from "../src/testing.js";

/**
 * Schema smoke test. Verifies the migration set produces the three
 * workflow tables (`workflows`, `workflow_nodes`, `workflow_edges`)
 * with the expected columns, NOT NULL / DEFAULT shape, and indexes.
 * Drives the schema via the migration runner so a future migration
 * that drifts the table shape is caught here, not at the first
 * production deploy.
 */

let handle: ReturnType<typeof openTestWorkflowDb>;

beforeEach(() => {
  handle = openTestWorkflowDb();
});

afterEach(() => {
  handle.close();
});

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

  it("workflows table has the expected column set", () => {
    const cols = handle.sqlite.prepare("PRAGMA table_info('workflows')").all() as {
      name: string;
      notnull: number;
    }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "brief",
        "cancellation",
        "coordinator_agent",
        "created_at",
        "details",
        "ended_at",
        "failure",
        "id",
        "metadata",
        "started_at",
        "status",
        "success",
      ].sort(),
    );
    // `coordinator_agent` is the denorm cache of the current coord
    // node's agent FQN; it must be NOT NULL so "who's running this
    // workflow?" is always answerable with a single-row read.
    const coordCol = cols.find((c) => c.name === "coordinator_agent");
    expect(coordCol?.notnull).toBe(1);
    // v2.2 terminal payload columns are nullable — they're only
    // populated on the terminal-status transition. Legacy rows
    // (terminal status + null payload) are tolerated by the entity
    // reader for backward compatibility with pre-v2.2 data.
    for (const name of ["success", "failure", "cancellation"]) {
      const col = cols.find((c) => c.name === name);
      expect(col?.notnull, `${name} should be nullable`).toBe(0);
    }
  });

  it("workflow_nodes table has the expected column set", () => {
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
    // `kind` and `spec_json` deliberately have no DEFAULT: every
    // INSERT must spell them out so the kind-handler registration
    // story stays honest (no silent "default kind").
    const kind = cols.find((c) => c.name === "kind");
    const spec = cols.find((c) => c.name === "spec_json");
    expect(kind?.notnull).toBe(1);
    expect(kind?.dflt_value).toBeNull();
    expect(spec?.notnull).toBe(1);
    expect(spec?.dflt_value).toBeNull();
    // `phase` is the node's topological depth, stored as INTEGER NN
    // so SQL ORDER BY phase yields the natural rendering order.
    const phase = cols.find((c) => c.name === "phase");
    expect(phase?.notnull).toBe(1);
    expect(phase?.type.toUpperCase()).toBe("INTEGER");
  });

  it("workflow_edges table has the expected column set + composite PK", () => {
    const cols = handle.sqlite.prepare("PRAGMA table_info('workflow_edges')").all() as {
      name: string;
      pk: number;
    }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["from_node_id", "to_node_id", "workflow_id"].sort());
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pkCols.sort()).toEqual(["from_node_id", "to_node_id", "workflow_id"].sort());
  });

  it("creates the indexes the substrate read patterns rely on", () => {
    const rows = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    // Workflow listings filter on status; admin lookup filters on
    // coordinator_agent.
    expect(names).toContain("workflows_status_idx");
    expect(names).toContain("workflows_coordinator_agent_idx");
    // Per-workflow scans + status-filtered scans.
    expect(names).toContain("workflow_nodes_workflow_idx");
    expect(names).toContain("workflow_nodes_status_idx");
    expect(names).not.toContain("workflow_nodes_phase_idx");
    // Edge lookups in both directions for the readiness check.
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
