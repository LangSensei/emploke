import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPkgMigrationsSync } from "../../src/migration/index.js";
import { WORKSPACE_MIGRATIONS } from "../../src/migrations/index.js";
import { SqliteWorkspaceRepository } from "../../src/repositories/sqlite-workspace-repository.js";

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

/**
 * Seed a v1-shape `workspaces` table directly via SQL: the columns
 * the pre-#121 `v0-to-v1.ts` produced. Mirrors a workspace registry
 * upgraded by a previous server version that shipped without the
 * v1→v2 migration applied yet.
 */
function seedV1Schema(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE schema_meta (
      pkg     TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0)
    );
    CREATE TABLE workspaces (
      id              TEXT PRIMARY KEY NOT NULL,
      workdir         TEXT NOT NULL UNIQUE,
      name            TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      registered_at   TEXT NOT NULL,
      last_opened_at  TEXT,
      defaults_json   TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE global_state (
      key   TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    INSERT INTO schema_meta (pkg, version) VALUES ('workspace', 1);
  `);
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("workspace v1→v2 migration applied via MigrationCoordinator", () => {
  // First business migration on the merged migration framework (PR
  // #124). The pattern established here — seed an explicit v(N) DB,
  // run the canonical coordinator entry-point, assert the resulting
  // shape — becomes the template for the rest of the v1-batch issues
  // (#118, #119, #120, #122).

  it("drops defaults_json, renames workdir → workspace_dir, preserves every other column", () => {
    seedV1Schema(db);
    db.prepare(
      `INSERT INTO workspaces (
         id, workdir, name, created_at, registered_at, last_opened_at, defaults_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      UUID_A,
      "/home/user/projects/alpha",
      "Alpha",
      "2026-05-15T00:00:00.000Z",
      "2026-05-15T00:00:01.000Z",
      "2026-05-18T12:34:56.000Z",
      '{"runtime":"gemini","agent":"langsensei/example"}',
    );
    db.prepare(
      `INSERT INTO workspaces (
         id, workdir, name, created_at, registered_at, last_opened_at, defaults_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      UUID_B,
      "/home/user/projects/beta",
      "Beta",
      "2026-05-16T00:00:00.000Z",
      "2026-05-16T00:00:01.000Z",
      null,
      "{}",
    );

    runPkgMigrationsSync(db, [{ pkg: "workspace", migrations: WORKSPACE_MIGRATIONS }]);

    // schema_meta bumped from 1 → 2 (only one step, not silently skipped).
    const ver = db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("workspace") as {
      version: number;
    };
    expect(ver.version).toBe(2);

    // The v2 column set: 6 columns; no `defaults_json`, no `workdir`,
    // new `workspace_dir` in the same slot as the renamed column.
    const cols = db.prepare("PRAGMA table_info(workspaces)").all() as {
      name: string;
      type: string;
      notnull: number;
    }[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("id")?.type).toBe("TEXT");
    expect(byName.get("workspace_dir")?.type).toBe("TEXT");
    expect(byName.get("workspace_dir")?.notnull).toBe(1);
    expect(byName.get("name")?.type).toBe("TEXT");
    expect(byName.get("created_at")?.type).toBe("TEXT");
    expect(byName.get("registered_at")?.type).toBe("TEXT");
    expect(byName.get("last_opened_at")?.type).toBe("TEXT");
    // Intentionally gone in v2 (issue #121).
    expect(byName.get("workdir")).toBeUndefined();
    expect(byName.get("defaults_json")).toBeUndefined();
    expect(cols).toHaveLength(6);

    // `workspace_dir UNIQUE` is preserved automatically via the inline
    // UNIQUE constraint on the v2 table. SQLite materialises an
    // auto-named UNIQUE index for it; assert one exists on the
    // workspace_dir column.
    const indexes = db.prepare("PRAGMA index_list(workspaces)").all() as {
      name: string;
      unique: number;
    }[];
    const uniqueIndexNames = indexes.filter((i) => i.unique === 1).map((i) => i.name);
    let foundWorkspaceDirIdx = false;
    for (const idxName of uniqueIndexNames) {
      const idxCols = db.prepare(`PRAGMA index_info(${idxName})`).all() as { name: string }[];
      if (idxCols.length === 1 && idxCols[0]?.name === "workspace_dir") {
        foundWorkspaceDirIdx = true;
      }
    }
    expect(foundWorkspaceDirIdx).toBe(true);

    // Row data: every surviving column preserved byte-for-byte; the
    // dropped `defaults_json` is not reachable.
    const alpha = db
      .prepare(
        `SELECT id, workspace_dir, name, created_at, registered_at, last_opened_at
         FROM workspaces WHERE id = ?`,
      )
      .get(UUID_A) as {
      id: string;
      workspace_dir: string;
      name: string;
      created_at: string;
      registered_at: string;
      last_opened_at: string | null;
    };
    expect(alpha.id).toBe(UUID_A);
    expect(alpha.workspace_dir).toBe("/home/user/projects/alpha");
    expect(alpha.name).toBe("Alpha");
    expect(alpha.created_at).toBe("2026-05-15T00:00:00.000Z");
    expect(alpha.registered_at).toBe("2026-05-15T00:00:01.000Z");
    expect(alpha.last_opened_at).toBe("2026-05-18T12:34:56.000Z");

    const beta = db
      .prepare(`SELECT id, workspace_dir, last_opened_at FROM workspaces WHERE id = ?`)
      .get(UUID_B) as { id: string; workspace_dir: string; last_opened_at: string | null };
    expect(beta.workspace_dir).toBe("/home/user/projects/beta");
    expect(beta.last_opened_at).toBeNull();
  });

  it("is idempotent: re-running against an already-v2 DB applies no migrations", () => {
    seedV1Schema(db);
    runPkgMigrationsSync(db, [{ pkg: "workspace", migrations: WORKSPACE_MIGRATIONS }]);
    const result = runPkgMigrationsSync(db, [
      { pkg: "workspace", migrations: WORKSPACE_MIGRATIONS },
    ]);
    expect(result.applied).toEqual([]);
    expect(result.alreadyAtTarget).toEqual(["workspace"]);
  });

  it("the repository reads the migrated row as a Workspace with no defaults", async () => {
    seedV1Schema(db);
    db.prepare(
      `INSERT INTO workspaces (
         id, workdir, name, created_at, registered_at, last_opened_at, defaults_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      UUID_A,
      "/home/user/projects/alpha",
      "Alpha",
      "2026-05-15T00:00:00.000Z",
      "2026-05-15T00:00:01.000Z",
      null,
      '{"runtime":"copilot"}',
    );

    runPkgMigrationsSync(db, [{ pkg: "workspace", migrations: WORKSPACE_MIGRATIONS }]);

    const repo = new SqliteWorkspaceRepository({ db });
    const back = await repo.read(UUID_A);
    expect(back).not.toBeNull();
    expect(back?.workspaceDir).toBe(path.resolve("/home/user/projects/alpha"));
    expect(back?.name).toBe("Alpha");
    // Defaults are gone from the entity entirely — the getter no
    // longer exists. Cast to any so the test compiles even after the
    // typed property is removed; we're explicitly asserting the
    // runtime shape.
    expect((back as unknown as { defaults?: unknown }).defaults).toBeUndefined();
  });
});
