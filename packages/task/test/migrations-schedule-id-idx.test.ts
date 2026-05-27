/**
 * PR 1 of #61: the `tasks_schedule_id_idx` functional index must
 * exist on a freshly-migrated database. This is the on-disk
 * counterpart to the `MIGRATIONS` array — the inventory test only
 * proves the SQL text round-trips into `migrations.ts`; this test
 * proves the SQL actually runs and the index is queryable via
 * SQLite's catalog.
 */

import { describe, expect, it } from "vitest";
import { openTestTaskDb } from "../src/testing.js";

describe("tasks_schedule_id_idx migration", () => {
  it("creates the functional index on a fresh in-memory database", () => {
    const orm = openTestTaskDb();
    try {
      const rows = orm.sqlite.prepare("PRAGMA index_list('tasks')").all() as Array<{
        name: string;
        partial: number;
      }>;
      const ours = rows.find((r) => r.name === "tasks_schedule_id_idx");
      expect(ours).toBeDefined();
      // The migration's `WHERE origin = 'schedule'` clause makes this
      // a partial index — SQLite exposes that as `partial = 1`.
      expect(ours?.partial).toBe(1);

      // The functional index is recognised by SQLite's
      // expression-index machinery, which exposes the expression as
      // the index's sole `info` row with `cid = -2` (computed column).
      // We don't pin that exact column-id (it's SQLite-version-
      // sensitive); we just check the index has at least one column
      // and the underlying CREATE INDEX text mentions `json_extract`.
      const info = orm.sqlite.prepare("PRAGMA index_info('tasks_schedule_id_idx')").all() as Array<{
        name: string | null;
      }>;
      expect(info.length).toBeGreaterThanOrEqual(1);

      const ddl = orm.sqlite
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND name='tasks_schedule_id_idx'",
        )
        .get() as { sql: string };
      expect(ddl.sql).toMatch(/json_extract/);
      expect(ddl.sql).toMatch(/scheduleId/);
      expect(ddl.sql).toMatch(/origin/);
    } finally {
      orm.close();
    }
  });

  it("the migration journal records two migrations, in order", () => {
    // `__drizzle_migrations_task` is populated by `applyTaskMigrations`
    // and pinned to the `task` pkg per the journal-table naming
    // convention in `migrations.ts`. Two SQL files → two journal rows.
    const orm = openTestTaskDb();
    try {
      const journal = orm.sqlite
        .prepare("SELECT id, hash, created_at FROM __drizzle_migrations_task ORDER BY id ASC")
        .all() as Array<{ id: number; hash: string; created_at: number }>;
      expect(journal.length).toBe(2);
      // Each entry has a non-empty hash matching the inlined hash
      // format (sha256 hex).
      for (const entry of journal) {
        expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      orm.close();
    }
  });
});
