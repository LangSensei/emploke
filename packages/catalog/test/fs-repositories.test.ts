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

  // pathFor was removed from McpRepository — the runtime fetches MCP
  // content via `read(name)` (or `CatalogManager.getMcpContent`) so the
  // catalog seam never has to expose on-disk paths to higher layers.

  it("delete is a no-op for missing entries", async () => {
    const repo = new FsMcpRepository(catalogDir);
    await expect(repo.delete("absent")).resolves.toBeUndefined();
  });
});

describe("FsAgentRepository.entries", () => {
  it("yields every file under the agent directory (incl. siblings)", async () => {
    const repo = new FsAgentRepository(catalogDir);
    const src = join(sourceDir, "agent-multi");
    await mkdir(join(src, "scripts"), { recursive: true });
    await writeFile(join(src, "AGENTS.md"), "agents-md");
    await writeFile(join(src, "prompt.txt"), "prompt-bytes");
    await writeFile(join(src, "scripts", "lint.sh"), "lint-bytes");
    await repo.installFromDir("multi", src);

    const got: Record<string, string> = {};
    for await (const { relPath, content } of repo.entries("multi")) {
      got[relPath] = content.toString("utf8");
    }
    expect(got).toEqual({
      "AGENTS.md": "agents-md",
      "prompt.txt": "prompt-bytes",
      "scripts/lint.sh": "lint-bytes",
    });
  });

  it("yields posix-style relPath even on Windows-style sources", async () => {
    const repo = new FsAgentRepository(catalogDir);
    const src = join(sourceDir, "agent-pathsep");
    await mkdir(join(src, "deep", "nest"), { recursive: true });
    await writeFile(join(src, "AGENTS.md"), "x");
    await writeFile(join(src, "deep", "nest", "f.md"), "y");
    await repo.installFromDir("pathsep", src);

    const seen = new Set<string>();
    for await (const { relPath } of repo.entries("pathsep")) seen.add(relPath);
    expect(seen).toContain("deep/nest/f.md");
    // Never the OS-native form.
    expect([...seen].some((p) => p.includes("\\"))).toBe(false);
  });

  it("throws NotFound when the agent doesn't exist", async () => {
    const repo = new FsAgentRepository(catalogDir);
    await expect(async () => {
      for await (const _ of repo.entries("absent")) {
        // unreachable
      }
    }).rejects.toMatchObject({ name: "NotFound" });
  });

  it("silently skips symlinks (file and directory) instead of following them", async () => {
    // Symlinks let an installed entry escape its own directory and
    // exfiltrate host files (e.g. `evil -> /etc/passwd`). The walker
    // must skip them entirely, not follow them.
    const repo = new FsAgentRepository(catalogDir);
    const src = join(sourceDir, "agent-with-symlink");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "AGENTS.md"), "agents-md");
    // Create a target outside the entry, then symlink to it.
    const outsideDir = join(sourceDir, "outside");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "secret.txt"), "should-not-leak");
    const { symlink } = await import("node:fs/promises");
    try {
      await symlink(join(outsideDir, "secret.txt"), join(src, "leak-file"));
      await symlink(outsideDir, join(src, "leak-dir"));
    } catch (e) {
      // Windows requires elevated perms or developer mode for symlinks.
      // If we can't create them the test is moot — skip it explicitly.
      if ((e as NodeJS.ErrnoException).code === "EPERM") return;
      throw e;
    }
    await repo.installFromDir("symlinky", src);

    const seen = new Set<string>();
    for await (const { relPath } of repo.entries("symlinky")) seen.add(relPath);
    expect(seen).toEqual(new Set(["AGENTS.md"]));
  });
});

describe("FsSkillRepository.entries", () => {
  it("yields SKILL.md plus all sibling files (incl. hooks/)", async () => {
    const repo = new FsSkillRepository(catalogDir);
    const src = join(sourceDir, "skill-multi");
    await mkdir(join(src, "hooks", "copilot"), { recursive: true });
    await writeFile(join(src, "SKILL.md"), "skill-md");
    await writeFile(join(src, "hooks", "copilot", "pre.js"), "pre-bytes");
    await repo.installFromDir("multi", src);

    const got: Record<string, string> = {};
    for await (const { relPath, content } of repo.entries("multi")) {
      got[relPath] = content.toString("utf8");
    }
    expect(got).toEqual({
      "SKILL.md": "skill-md",
      "hooks/copilot/pre.js": "pre-bytes",
    });
  });
});
