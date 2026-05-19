import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationCoordinator } from "../../src/migration/coordinator.js";
import type { Migration } from "../../src/migration/types.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
});

// Two pkgs; the task v3→v4 declares a cross-pkg dependsOn that means
// "must run after the workflow pkg has been bootstrapped". The
// coordinator must topo-sort the combined pending set so workflow:1
// is applied before task:4.

const workflowV0V1: Migration = {
  pkg: "workflow",
  fromVersion: 0,
  toVersion: 1,
  schemaSQL: `
    CREATE TABLE workflow (id INTEGER PRIMARY KEY);
  `,
};

const taskV0V1: Migration = {
  pkg: "task",
  fromVersion: 0,
  toVersion: 1,
  schemaSQL: `
    CREATE TABLE task (
      id INTEGER PRIMARY KEY,
      workflow_id INTEGER
    );
  `,
};
const taskV1V2: Migration = {
  pkg: "task",
  fromVersion: 1,
  toVersion: 2,
  schemaSQL: "ALTER TABLE task ADD COLUMN status TEXT;",
};
const taskV2V3: Migration = {
  pkg: "task",
  fromVersion: 2,
  toVersion: 3,
  schemaSQL: "ALTER TABLE task ADD COLUMN note TEXT;",
};
const taskV3V4: Migration = {
  pkg: "task",
  fromVersion: 3,
  toVersion: 4,
  dependsOn: ["workflow:1"],
  // Add a real cross-pkg FK to verify the table actually exists when
  // this migration runs. SQLite enforces FK definitions exist
  // structurally at table-create time (with foreign_keys=ON for
  // checks), so the rebuild dance proves workflow already exists.
  schemaSQL: `
    CREATE TABLE task_new (
      id INTEGER PRIMARY KEY,
      workflow_id INTEGER REFERENCES workflow(id),
      status TEXT,
      note TEXT
    );
    INSERT INTO task_new SELECT id, workflow_id, status, note FROM task;
    DROP TABLE task;
    ALTER TABLE task_new RENAME TO task;
  `,
};

describe("MigrationCoordinator — cross-pkg dependsOn", () => {
  it("orders workflow:0→1 before task:3→4 because task declares dependsOn ['workflow:1']", async () => {
    const c = new MigrationCoordinator();
    // Register in the "wrong" order to make the topo sort do work
    c.register("task", [taskV0V1, taskV1V2, taskV2V3, taskV3V4]);
    c.register("workflow", [workflowV0V1]);
    const result = await c.run(db);

    // Find positions
    const labels = result.applied.map((m) => `${m.pkg}:${m.toVersion}`);
    const workflowIdx = labels.indexOf("workflow:1");
    const taskV4Idx = labels.indexOf("task:4");
    expect(workflowIdx).toBeGreaterThanOrEqual(0);
    expect(taskV4Idx).toBeGreaterThanOrEqual(0);
    expect(workflowIdx).toBeLessThan(taskV4Idx);

    // Final versions are correct
    const workflowVer = db
      .prepare("SELECT version FROM schema_meta WHERE pkg = ?")
      .get("workflow") as { version: number };
    const taskVer = db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("task") as {
      version: number;
    };
    expect(workflowVer.version).toBe(1);
    expect(taskVer.version).toBe(4);
  });
});
