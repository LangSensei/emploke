import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Mcp } from "../../src/mcp/mcp-entity.js";
import { SqliteMcpRepository } from "../../src/mcp/sqlite-mcp-repository.js";
import { bootstrapCatalogDb } from "../helpers/bootstrap.js";

async function newRepo(): Promise<{ repo: SqliteMcpRepository; db: DatabaseSync }> {
  const db = new DatabaseSync(":memory:");
  await bootstrapCatalogDb(db);
  return { repo: new SqliteMcpRepository({ db }), db };
}

describe("SqliteMcpRepository.add + get", () => {
  it("round-trips a Mcp entity (identity + spec)", async () => {
    const { repo, db } = await newRepo();
    const m = Mcp.create("azure/mcp", "file:/abs/azure", '{"command":"node"}');
    await repo.add(m);
    const got = await repo.findByFqn("azure/mcp");
    expect(got).not.toBeNull();
    expect(got!.fqn).toBe(m.fqn);
    expect(got!.origin).toBe(m.origin);
    expect(got!.spec).toBe(m.spec);
    expect(got!.installedAt).toBeTypeOf("string");
    db.close();
  });

  it("preserves spec bytes verbatim", async () => {
    const { repo, db } = await newRepo();
    const raw =
      '{\n  "command": "node",\n  "_meta": { "name": "x/y", "origin": "file:/abs/x" }\n}\n';
    const now = new Date().toISOString();
    await repo.add(Mcp.fromStored("x/y", "file:/abs/x", raw, now, now));
    const got = await repo.findByFqn("x/y");
    expect(got!.spec).toBe(raw);
    db.close();
  });

  it("returns null when entry is absent", async () => {
    const { repo, db } = await newRepo();
    expect(await repo.findByFqn("nope/missing")).toBeNull();
    db.close();
  });

  it("upserts on add (overwrites existing entry)", async () => {
    const { repo, db } = await newRepo();
    await repo.add(Mcp.create("x/y", "file:/abs/v1", '{"v":1}'));
    await repo.add(Mcp.create("x/y", "file:/abs/v2", '{"v":2}'));
    const got = await repo.findByFqn("x/y");
    expect(got!.origin).toBe("file:/abs/v2");
    expect(JSON.parse(got!.spec).v).toBe(2);
    db.close();
  });

  it("supports namespaces with dots (reverse-DNS)", async () => {
    const { repo, db } = await newRepo();
    await repo.add(Mcp.create("io.github.user/weather-tool", "file:/abs/x", "{}"));
    const got = await repo.findByFqn("io.github.user/weather-tool");
    expect(got).not.toBeNull();
    db.close();
  });

  it("rejects spec that fails the json_valid CHECK", async () => {
    const { repo, db } = await newRepo();
    // Use a raw INSERT to bypass entity validation and verify the DB
    // constraint actually fires.
    expect(() =>
      db
        .prepare(
          "INSERT INTO mcps (fqn, origin, spec, installed_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("bad/json", "file:/abs/bad", "{not json", "2026-01-01", "2026-01-01"),
    ).toThrow(/CHECK constraint failed/);
    void repo; // keep linter happy
    db.close();
  });
});

describe("SqliteMcpRepository.delete", () => {
  it("removes an existing entry", async () => {
    const { repo, db } = await newRepo();
    await repo.add(Mcp.create("x/y", "file:/abs/x", "{}"));
    await repo.delete("x/y");
    expect(await repo.findByFqn("x/y")).toBeNull();
    db.close();
  });

  it("is a no-op when entry doesn't exist", async () => {
    const { repo, db } = await newRepo();
    await expect(repo.delete("never/existed")).resolves.toBeUndefined();
    db.close();
  });
});

describe("SqliteMcpRepository.list", () => {
  it("returns empty when nothing is installed", async () => {
    const { repo, db } = await newRepo();
    expect(await repo.findAll()).toEqual([]);
    db.close();
  });

  it("findAll lists installed entities sorted by fqn", async () => {
    const { repo, db } = await newRepo();
    await repo.add(Mcp.create("ns2/c", "file:/abs/c", "{}"));
    await repo.add(Mcp.create("ns1/a", "file:/abs/a", "{}"));
    await repo.add(Mcp.create("ns1/b", "file:/abs/b", "{}"));
    expect((await repo.findAll()).map((m) => m.fqn)).toEqual(["ns1/a", "ns1/b", "ns2/c"]);
    db.close();
  });
});

describe("SqliteMcpRepository persistence", () => {
  it("persists across repository instances on the same connection", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      await bootstrapCatalogDb(db);
      const repo1 = new SqliteMcpRepository({ db });
      await repo1.add(Mcp.create("x/y", "file:/abs/x", '{"v":1}'));

      const repo2 = new SqliteMcpRepository({ db });
      const got = await repo2.findByFqn("x/y");
      expect(got).not.toBeNull();
      expect(got!.origin).toBe("file:/abs/x");
    } finally {
      db.close();
    }
  });
});
