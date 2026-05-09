import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NameInvalid } from "../src/errors.js";
import { FsAgentRepository } from "../src/repositories/fs-agent-repository.js";
import { FsMcpRepository } from "../src/repositories/fs-mcp-repository.js";
import { FsSkillRepository } from "../src/repositories/fs-skill-repository.js";

let catalogDir: string;
let sourceDir: string;

beforeEach(async () => {
  const base = join(tmpdir(), `fs-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  catalogDir = join(base, "catalog");
  sourceDir = join(base, "source");
  await mkdir(catalogDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
});

afterEach(async () => {
  await rm(join(catalogDir, ".."), { recursive: true, force: true });
});

describe("FsAgentRepository", () => {
  it("read returns null for missing entries", async () => {
    const repo = new FsAgentRepository(catalogDir);
    expect(await repo.read("nope")).toBeNull();
  });

  it("write + read round-trips content", async () => {
    const repo = new FsAgentRepository(catalogDir);
    await repo.write("a", "hello");
    expect(await repo.read("a")).toBe("hello");
  });

  it("installFromDir copies AGENTS.md and sibling files atomically", async () => {
    const repo = new FsAgentRepository(catalogDir);
    const src = join(sourceDir, "agent-alpha");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "AGENTS.md"), "alpha-content");
    await writeFile(join(src, "extra.txt"), "extra-bytes");

    await repo.installFromDir("alpha", src);

    expect(await repo.read("alpha")).toBe("alpha-content");
    const extra = await readFile(join(catalogDir, "agents", "alpha", "extra.txt"), "utf8");
    expect(extra).toBe("extra-bytes");
  });

  it("delete removes an entry; subsequent read returns null", async () => {
    const repo = new FsAgentRepository(catalogDir);
    await repo.write("doomed", "x");
    await repo.delete("doomed");
    expect(await repo.read("doomed")).toBeNull();
  });

  it("scan returns all candidate AGENTS.md (raw, no parsing)", async () => {
    const repo = new FsAgentRepository(catalogDir);
    await repo.write("a", "---\nname: a\n---");
    await repo.write("b", "garbage that doesn't parse");
    const entries = await repo.scan();
    const contents = entries.map((e) => e.content).sort();
    expect(contents).toEqual(["---\nname: a\n---", "garbage that doesn't parse"]);
  });

  it("validateName guards path traversal in read/write/delete", async () => {
    const repo = new FsAgentRepository(catalogDir);
    await expect(repo.read("../escape")).rejects.toBeInstanceOf(NameInvalid);
    await expect(repo.write("../escape", "x")).rejects.toBeInstanceOf(NameInvalid);
    await expect(repo.delete("../escape")).rejects.toBeInstanceOf(NameInvalid);
  });
});

describe("FsSkillRepository", () => {
  it("write + read round-trips content", async () => {
    const repo = new FsSkillRepository(catalogDir);
    await repo.write("s", "skill-content");
    expect(await repo.read("s")).toBe("skill-content");
  });

  it("scan returns raw entries (no SKILL.md parsing)", async () => {
    const repo = new FsSkillRepository(catalogDir);
    await repo.write("a", "---\nname: a\n---");
    const entries = await repo.scan();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.content).toBe("---\nname: a\n---");
    expect(entries[0]!.sourcePath).toContain("SKILL.md");
  });
});

describe("FsMcpRepository", () => {
  it("scan derives names from filenames (incl. one-level scope dirs)", async () => {
    const repo = new FsMcpRepository(catalogDir);
    await repo.write("github", '{"command":"gh"}');
    await repo.write("io.playwright/mcp", '{"command":"pw"}');
    const entries = await repo.scan();
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["github", "io.playwright/mcp"]);
  });

  it("pathFor returns the on-disk JSON file path", async () => {
    const repo = new FsMcpRepository(catalogDir);
    const p = repo.pathFor("github");
    expect(p).toContain("mcps");
    expect(p).toMatch(/github\.json$/);
  });

  it("delete is a no-op for missing entries", async () => {
    const repo = new FsMcpRepository(catalogDir);
    await expect(repo.delete("absent")).resolves.toBeUndefined();
  });
});
