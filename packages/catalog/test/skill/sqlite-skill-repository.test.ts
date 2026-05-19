import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Skill } from "../../src/skill/skill-entity.js";
import { SqliteSkillRepository } from "../../src/skill/sqlite-skill-repository.js";
import { bootstrapCatalogDb } from "../helpers/bootstrap.js";

const MIN_VALID = `---
name: tool-use
description: Helpful patterns
version: 1.0.0
---
# Body
`;

let db: DatabaseSync;
let repo: SqliteSkillRepository;

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  await bootstrapCatalogDb(db);
  repo = new SqliteSkillRepository({ db });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
});

const EMPTY_DEPS = { skills: [], mcps: [] };

function fixture(
  opts: { name?: string; origin?: string; body?: string; files?: ReadonlyMap<string, Buffer> } = {},
): { skill: Skill; files: Map<string, Buffer>; anchorBytes: string } {
  const anchor = (opts.body ?? MIN_VALID).replace(
    "name: tool-use",
    `name: ${opts.name ?? "tool-use"}`,
  );
  const skill = Skill.create(anchor, opts.origin ?? "file:/abs/test", "fixture");
  const files = new Map(opts.files ?? new Map());
  files.set("SKILL.md", Buffer.from(anchor, "utf8"));
  return { skill, files, anchorBytes: anchor };
}

describe("SqliteSkillRepository.add + findByFqn", () => {
  it("round-trips entity metadata", async () => {
    const { skill, files, anchorBytes } = fixture();
    await repo.add(skill, files, EMPTY_DEPS);
    const got = await repo.findByFqn(skill.fqn);
    expect(got).not.toBeNull();
    expect(got!.fqn).toBe(skill.fqn);
    expect(got!.origin).toBe(skill.origin);
    expect(got!.scope).toBe("public");
    expect(got!.version).toBe("1.0.0");
    expect(got!.description).toBe("Helpful patterns");
    expect(got!.installedAt).toBeTypeOf("string");
    expect(got!.updatedAt).toBeTypeOf("string");
    expect(await repo.getAnchor(skill.fqn)).toBe(anchorBytes);
  });

  it("persists fqn-form dependencies via the dep tables", async () => {
    // Pre-install a sibling skill + mcp so the FK targets exist.
    const sib = fixture({ name: "child", origin: "file:/abs/child" });
    await repo.add(sib.skill, sib.files, EMPTY_DEPS);
    db.prepare(
      "INSERT INTO mcps (fqn, origin, spec, installed_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "azure/mcp",
      "file:/abs/mcps/azure",
      '{"_meta":{"name":"azure/mcp"}}',
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const parent = fixture({ name: "parent", origin: "file:/abs/parent" });
    await repo.add(parent.skill, parent.files, {
      skills: ["public/child"],
      mcps: ["azure/mcp"],
    });
    const got = await repo.findByFqn(parent.skill.fqn);
    expect(got!.dependencies.skills).toEqual([{ fqn: "public/child" }]);
    expect(got!.dependencies.mcps).toEqual([{ fqn: "azure/mcp" }]);
  });

  it("returns null when entry is absent", async () => {
    expect(await repo.findByFqn("public/missing")).toBeNull();
  });

  it("rejects add() without SKILL.md in files", async () => {
    const { skill } = fixture();
    const filesWithoutAnchor = new Map([["other.md", Buffer.from("x")]]);
    await expect(repo.add(skill, filesWithoutAnchor, EMPTY_DEPS)).rejects.toThrow(/SKILL\.md/);
  });

  it("upserts on add (overwrites all sibling files atomically)", async () => {
    const { skill, anchorBytes } = fixture();
    const v1Files = new Map<string, Buffer>([
      ["SKILL.md", Buffer.from(anchorBytes, "utf8")],
      ["v1-only.txt", Buffer.from("v1")],
    ]);
    await repo.add(skill, v1Files, EMPTY_DEPS);

    const v2Files = new Map<string, Buffer>([
      ["SKILL.md", Buffer.from(anchorBytes, "utf8")],
      ["v2-only.txt", Buffer.from("v2")],
    ]);
    await repo.add(skill, v2Files, EMPTY_DEPS);

    const out = await collectFiles(repo, skill.fqn);
    expect(out.has("v1-only.txt")).toBe(false);
    expect(out.has("v2-only.txt")).toBe(true);
    expect(out.has("SKILL.md")).toBe(true);
  });
});

describe("SqliteSkillRepository.findByOrigin", () => {
  it("returns entity matching origin", async () => {
    const { skill, files } = fixture({ origin: "github:o/r/tree/main/x" });
    await repo.add(skill, files, EMPTY_DEPS);
    const got = await repo.findByOrigin("github:o/r/tree/main/x");
    expect(got!.fqn).toBe(skill.fqn);
  });

  it("returns null when no entry's origin matches", async () => {
    expect(await repo.findByOrigin("file:/abs/never")).toBeNull();
  });
});

describe("SqliteSkillRepository.findAll + delete + streamFiles", () => {
  it("findAll returns sorted entities", async () => {
    const a = fixture({ name: "alpha", origin: "file:/abs/a" });
    const b = fixture({ name: "beta", origin: "file:/abs/b" });
    await repo.add(a.skill, a.files, EMPTY_DEPS);
    await repo.add(b.skill, b.files, EMPTY_DEPS);
    const all = await repo.findAll();
    expect(all.map((s) => s.fqn)).toEqual(["public/alpha", "public/beta"]);
  });

  it("delete removes entry and cascades sibling files", async () => {
    const { skill, files } = fixture();
    files.set("scripts/run.sh", Buffer.from("#!/bin/bash"));
    await repo.add(skill, files, EMPTY_DEPS);
    await repo.delete(skill.fqn);
    expect(await repo.findByFqn(skill.fqn)).toBeNull();
    const remainingFiles = await collectFiles(repo, skill.fqn);
    expect(remainingFiles.size).toBe(0);
  });

  it("streamFiles yields all files including SKILL.md", async () => {
    const { skill, files } = fixture();
    files.set("scripts/run.sh", Buffer.from("#!/bin/bash"));
    files.set("data/notes.txt", Buffer.from("notes"));
    await repo.add(skill, files, EMPTY_DEPS);
    const out = await collectFiles(repo, skill.fqn);
    expect(out.has("SKILL.md")).toBe(true);
    expect(out.get("scripts/run.sh")?.toString("utf8")).toBe("#!/bin/bash");
    expect(out.get("data/notes.txt")?.toString("utf8")).toBe("notes");
  });

  it("streamFiles preserves binary bytes", async () => {
    const { skill, files } = fixture();
    const bin = Buffer.from([0x00, 0xff, 0x80, 0x42]);
    files.set("blob.bin", bin);
    await repo.add(skill, files, EMPTY_DEPS);
    const out = await collectFiles(repo, skill.fqn);
    expect(Buffer.compare(out.get("blob.bin")!, bin)).toBe(0);
  });
});

describe("SqliteSkillRepository v2 — getAnchor / dep helpers", () => {
  it("getAnchor returns the SKILL.md bytes (catalog v2 explicit fetch)", async () => {
    const { skill, files, anchorBytes } = fixture();
    await repo.add(skill, files, EMPTY_DEPS);
    expect(await repo.getAnchor(skill.fqn)).toBe(anchorBytes);
  });

  it("findDependentSkills / findDependentAgents return source fqns", async () => {
    const a = fixture({ name: "alpha", origin: "file:/abs/a" });
    const b = fixture({ name: "beta", origin: "file:/abs/b" });
    await repo.add(a.skill, a.files, EMPTY_DEPS);
    await repo.add(b.skill, b.files, { skills: ["public/alpha"], mcps: [] });
    expect(await repo.findDependentSkills("public/alpha")).toEqual(["public/beta"]);
  });

  it("listDependencies returns fqn arrays", async () => {
    const child = fixture({ name: "child", origin: "file:/abs/child" });
    await repo.add(child.skill, child.files, EMPTY_DEPS);
    const parent = fixture({ name: "parent", origin: "file:/abs/parent" });
    await repo.add(parent.skill, parent.files, { skills: ["public/child"], mcps: [] });
    const deps = await repo.listDependencies("public/parent");
    expect(deps.skills).toEqual([{ fqn: "public/child" }]);
  });
});

async function collectFiles(r: SqliteSkillRepository, name: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for await (const f of r.streamFiles(name)) out.set(f.relPath, f.content);
  return out;
}
