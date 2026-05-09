import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCatalog } from "../src/agent/agent-catalog.js";
import { McpCatalog } from "../src/mcp/mcp-catalog.js";
import { SkillCatalog } from "../src/skill/skill-catalog.js";
import {
  InMemoryAgentRepository,
  InMemoryMcpRepository,
  InMemorySkillRepository,
} from "../testing.js";

let sourceDir: string;

beforeEach(async () => {
  sourceDir = join(tmpdir(), `inmem-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(sourceDir, { recursive: true });
});

afterEach(async () => {
  await rm(sourceDir, { recursive: true, force: true });
});

describe("Stores wired to InMemory repositories", () => {
  it("AgentCatalog.install + scan round-trips through InMemoryAgentRepository", async () => {
    const repo = new InMemoryAgentRepository();
    const store = new AgentCatalog(repo);
    const dir = join(sourceDir, "alpha-src");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "AGENTS.md"),
      ["---", "name: alpha", "description: Alpha", "---", "# body"].join("\n"),
    );

    await store.install(dir);
    expect(store.has("alpha")).toBe(true);
    expect(store.get("alpha")?.description).toBe("Alpha");

    // A fresh Store backed by the same repo recovers state via scan().
    const reborn = new AgentCatalog(repo);
    const issues = await reborn.scan();
    expect(issues).toEqual([]);
    expect(reborn.has("alpha")).toBe(true);
  });

  it("SkillCatalog.updateContent is observable via the repository", async () => {
    const repo = new InMemorySkillRepository();
    const store = new SkillCatalog(repo);
    const dir = join(sourceDir, "lint-src");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      ["---", "name: lint", "description: Lint", "---", "# body"].join("\n"),
    );

    await store.install(dir);
    await store.updateContent(
      "lint",
      ["---", "name: lint", "description: Lint v2", "---", "# body"].join("\n"),
    );
    expect(store.get("lint")?.description).toBe("Lint v2");
    expect(await repo.read("lint")).toContain("Lint v2");
  });

  it("McpCatalog install + remove updates the repository", async () => {
    const repo = new InMemoryMcpRepository();
    const store = new McpCatalog(repo);
    const file = join(sourceDir, "github.json");
    await writeFile(file, '{"command":"gh"}');

    const name = await store.install(file);
    expect(name).toBe("github");
    expect(store.has("github")).toBe(true);
    expect(await repo.read("github")).toBe('{"command":"gh"}');

    await store.remove("github", () => []);
    expect(store.has("github")).toBe(false);
    expect(await repo.read("github")).toBeNull();
  });
});
