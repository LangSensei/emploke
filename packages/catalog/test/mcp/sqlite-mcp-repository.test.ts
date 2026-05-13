import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Mcp } from "../../src/mcp/mcp-entity.js";
import { SqliteMcpRepository } from "../../src/mcp/sqlite-mcp-repository.js";

function newRepo(): { repo: SqliteMcpRepository; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return { repo: new SqliteMcpRepository({ db }), db };
}

describe("SqliteMcpRepository.add + get", () => {
  it("round-trips a Mcp entity (identity + content)", async () => {
    const { repo, db } = newRepo();
    const m = Mcp.create("azure/mcp", "file:/abs/azure", '{"command":"node"}');
    await repo.add(m);
    const got = await repo.findByName("azure/mcp");
    expect(got).not.toBeNull();
    expect(got!.name).toBe(m.name);
    expect(got!.origin).toBe(m.origin);
    expect(got!.content).toBe(m.content);
    db.close();
  });

  it("preserves content bytes verbatim", async () => {
    const { repo, db } = newRepo();
    const raw =
      '{\n  "command": "node",\n  "_meta": { "name": "x/y", "origin": "file:/abs/x" }\n}\n';
    await repo.add(Mcp.fromStored("x/y", "file:/abs/x", raw));
    const got = await repo.findByName("x/y");
    expect(got!.content).toBe(raw);
    db.close();
  });

  it("returns null when entry is absent", async () => {
    const { repo, db } = newRepo();
    expect(await repo.findByName("nope/missing")).toBeNull();
    db.close();
  });

  it("upserts on add (overwrites existing entry)", async () => {
    const { repo, db } = newRepo();
    await repo.add(Mcp.create("x/y", "file:/abs/v1", '{"v":1}'));
    await repo.add(Mcp.create("x/y", "file:/abs/v2", '{"v":2}'));
    const got = await repo.findByName("x/y");
    expect(got!.origin).toBe("file:/abs/v2");
    expect(JSON.parse(got!.content).v).toBe(2);
    db.close();
  });

  it("supports namespaces with dots (reverse-DNS)", async () => {
    const { repo, db } = newRepo();
    await repo.add(Mcp.create("io.github.user/weather-tool", "file:/abs/x", "{}"));
    const got = await repo.findByName("io.github.user/weather-tool");
    expect(got).not.toBeNull();
    db.close();
  });
});

describe("SqliteMcpRepository.delete", () => {
  it("removes an existing entry", async () => {
    const { repo, db } = newRepo();
    await repo.add(Mcp.create("x/y", "file:/abs/x", "{}"));
    await repo.delete("x/y");
    expect(await repo.findByName("x/y")).toBeNull();
    db.close();
  });

  it("is a no-op when entry doesn't exist", async () => {
    const { repo, db } = newRepo();
    await expect(repo.delete("never/existed")).resolves.toBeUndefined();
    db.close();
  });
});

describe("SqliteMcpRepository.list + scan", () => {
  it("returns empty when nothing is installed", async () => {
    const { repo, db } = newRepo();
    expect(await repo.findAll()).toEqual([]);
    db.close();
  });

  it("findAll lists installed entities sorted by name", async () => {
    const { repo, db } = newRepo();
    await repo.add(Mcp.create("ns2/c", "file:/abs/c", "{}"));
    await repo.add(Mcp.create("ns1/a", "file:/abs/a", "{}"));
    await repo.add(Mcp.create("ns1/b", "file:/abs/b", "{}"));
    expect((await repo.findAll()).map((m) => m.name)).toEqual(["ns1/a", "ns1/b", "ns2/c"]);
    db.close();
  });

  it("scan returns reconstituted Mcp entities", async () => {
    const { repo, db } = newRepo();
    await repo.add(Mcp.create("ns1/a", "file:/abs/a", '{"v":1}'));
    await repo.add(Mcp.create("ns2/b", "github:owner/repo/tree/main/b", '{"v":2}'));
    const entities = await repo.findAll();
    expect(entities).toHaveLength(2);
    expect(entities[0].name).toBe("ns1/a");
    expect(entities[0].origin).toBe("file:/abs/a");
    expect(entities[1].name).toBe("ns2/b");
    expect(JSON.parse(entities[1].content).v).toBe(2);
    db.close();
  });
});

describe("SqliteMcpRepository persistence", () => {
  it("persists across repository instances on the same connection", async () => {
    // The repo no longer owns the connection — the workspace pkg does.
    // To exercise "second-open survives" against the same data, share
    // a single in-memory connection across two repo instances.
    const db = new DatabaseSync(":memory:");
    try {
      const repo1 = new SqliteMcpRepository({ db });
      await repo1.add(Mcp.create("x/y", "file:/abs/x", '{"v":1}'));

      const repo2 = new SqliteMcpRepository({ db });
      const got = await repo2.findByName("x/y");
      expect(got).not.toBeNull();
      expect(got!.origin).toBe("file:/abs/x");
    } finally {
      db.close();
    }
  });
});

describe("SqliteMcpRepository concurrency (single-process)", () => {
  it("serializes concurrent adds via SQLite's internal locking", async () => {
    const { repo, db } = newRepo();
    // Fire many concurrent adds; SQLite must serialize them and end up
    // with one consistent state per name.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        repo.add(Mcp.create(`ns/${i}`, `file:${i}`, `{"v":${i}}`)),
      ),
    );
    expect(await repo.findAll()).toHaveLength(20);
    db.close();
  });

  it("upsert is atomic — last writer wins, no torn state", async () => {
    const { repo, db } = newRepo();
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        repo.add(Mcp.create("x/y", `file:writer-${i}`, `{"v":${i}}`)),
      ),
    );
    const got = await repo.findByName("x/y");
    // Whichever writer landed last, the entity is well-formed (content
    // and origin are consistent — no half-written state)
    expect(got).not.toBeNull();
    const v = JSON.parse(got!.content).v;
    expect(got!.origin).toBe(`file:writer-${v}`);
    db.close();
  });
});
