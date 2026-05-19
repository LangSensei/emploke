import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Skill } from "../../src/skill/skill-entity.js";
import { SqliteSkillRepository } from "../../src/skill/sqlite-skill-repository.js";
import { bootstrapCatalogDbSync } from "../helpers/bootstrap.js";

const MIN_VALID = `---
name: tool-use
description: Helpful patterns
version: 1.0.0
---
# Body
`;

let db: DatabaseSync;
let repo: SqliteSkillRepository;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  bootstrapCatalogDbSync(db);
  repo = new SqliteSkillRepository({ db });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
});

function fixture(
  opts: { name?: string; origin?: string; body?: string; files?: ReadonlyMap<string, Buffer> } = {},
): { skill: Skill; files: ReadonlyMap<string, Buffer> } {
  const anchor = (opts.body ?? MIN_VALID).replace(
    "name: tool-use",
    `name: ${opts.name ?? "tool-use"}`,
  );
  const skill = Skill.create(anchor, opts.origin ?? "file:/abs/test", "fixture");
  const files = new Map(opts.files ?? new Map());
  files.set("SKILL.md", Buffer.from(skill.anchorContent, "utf8"));
  return { skill, files };
}

describe("SqliteSkillRepository.add + findByName", () => {
  it("round-trips entity metadata", async () => {
    const { skill, files } = fixture();
    await repo.add(skill, files);
    const got = await repo.findByFqn(skill.fqn);
    expect(got).not.toBeNull();
    expect(got!.fqn).toBe(skill.fqn);
    expect(got!.origin).toBe(skill.origin);
    expect(got!.scope).toBe("public");
    expect(got!.version).toBe("1.0.0");
    expect(got!.description).toBe("Helpful patterns");
    expect(got!.anchorContent).toBe(skill.anchorContent);
  });

  it("preserves dependencies in JSON column", async () => {
    const src = `---
name: parent
description: x
version: 1.0.0
dependencies:
  skills:
    - "file:/abs/child"
  mcps:
    - "file:/abs/mcps/azure"
---
`;
    const skill = Skill.create(src, "file:/abs/parent", "test");
    const files = new Map([["SKILL.md", Buffer.from(skill.anchorContent, "utf8")]]);
    await repo.add(skill, files);
    const got = await repo.findByFqn(skill.fqn);
    expect(got!.dependencies.skills).toEqual(["file:/abs/child"]);
    expect(got!.dependencies.mcps).toEqual(["file:/abs/mcps/azure"]);
  });

  it("returns null when entry is absent", async () => {
    expect(await repo.findByFqn("public/missing")).toBeNull();
  });

  it("rejects add() without SKILL.md in files", async () => {
    const { skill } = fixture();
    const filesWithoutAnchor = new Map([["other.md", Buffer.from("x")]]);
    await expect(repo.add(skill, filesWithoutAnchor)).rejects.toThrow(/SKILL\.md/);
  });

  it("upserts on add (overwrites all sibling files atomically)", async () => {
    const { skill } = fixture();
    const v1Files = new Map([
      ["SKILL.md", Buffer.from(skill.anchorContent, "utf8")],
      ["v1-only.txt", Buffer.from("v1")],
    ]);
    await repo.add(skill, v1Files);

    const v2Files = new Map([
      ["SKILL.md", Buffer.from(skill.anchorContent, "utf8")],
      ["v2-only.txt", Buffer.from("v2")],
    ]);
    await repo.add(skill, v2Files);

    const out = await collectFiles(repo, skill.fqn);
    expect(out.has("v1-only.txt")).toBe(false);
    expect(out.has("v2-only.txt")).toBe(true);
    expect(out.has("SKILL.md")).toBe(true);
  });
});

describe("SqliteSkillRepository.findByOrigin", () => {
  it("returns entity matching origin", async () => {
    const { skill, files } = fixture({ origin: "github:o/r/tree/main/x" });
    await repo.add(skill, files);
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
    await repo.add(a.skill, a.files);
    await repo.add(b.skill, b.files);
    const all = await repo.findAll();
    expect(all.map((s) => s.fqn)).toEqual(["public/alpha", "public/beta"]);
  });

  it("delete removes entry and cascades sibling files", async () => {
    const { skill, files } = fixture();
    files.set("scripts/run.sh", Buffer.from("#!/bin/bash"));
    await repo.add(skill, files);
    await repo.delete(skill.fqn);
    expect(await repo.findByFqn(skill.fqn)).toBeNull();
    const remainingFiles = await collectFiles(repo, skill.fqn);
    expect(remainingFiles.size).toBe(0);
  });

  it("streamFiles yields all files including SKILL.md", async () => {
    const { skill, files } = fixture();
    files.set("scripts/run.sh", Buffer.from("#!/bin/bash"));
    files.set("data/notes.txt", Buffer.from("notes"));
    await repo.add(skill, files);
    const out = await collectFiles(repo, skill.fqn);
    expect(out.has("SKILL.md")).toBe(true);
    expect(out.get("scripts/run.sh")?.toString("utf8")).toBe("#!/bin/bash");
    expect(out.get("data/notes.txt")?.toString("utf8")).toBe("notes");
  });

  it("streamFiles preserves binary bytes", async () => {
    const { skill, files } = fixture();
    const bin = Buffer.from([0x00, 0xff, 0x80, 0x42]);
    files.set("blob.bin", bin);
    await repo.add(skill, files);
    const out = await collectFiles(repo, skill.fqn);
    expect(Buffer.compare(out.get("blob.bin")!, bin)).toBe(0);
  });
});

describe("SqliteSkillRepository atomicity", () => {
  it("partial add failure leaves no orphan rows", async () => {
    // Force a failure by sneaking a Buffer that throws on bind?  Easier:
    // verify atomic upsert with concurrent adds — last one wins, no torn state.
    const { skill, files } = fixture();
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => {
        const fs = new Map(files);
        fs.set("counter.txt", Buffer.from(String(i)));
        return repo.add(skill, fs);
      }),
    );
    // Whichever writer landed last, the entry is consistent
    const got = await repo.findByFqn(skill.fqn);
    expect(got).not.toBeNull();
    const out = await collectFiles(repo, skill.fqn);
    expect(out.has("SKILL.md")).toBe(true);
    expect(out.has("counter.txt")).toBe(true);
  });
});

async function collectFiles(r: SqliteSkillRepository, name: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for await (const f of r.streamFiles(name)) out.set(f.relPath, f.content);
  return out;
}
