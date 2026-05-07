import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "../src/agent/agent-store.js";
import { McpStore } from "../src/mcp/mcp-store.js";
import { Resolver } from "../src/resolver.js";
import { SkillStore } from "../src/skill/skill-store.js";

let catalogDir: string;
let sourceDir: string;
let skills: SkillStore;
let agents: AgentStore;
let mcps: McpStore;
let resolver: Resolver;

async function makeSkill(
  name: string,
  deps?: { skills?: string[]; mcps?: string[] },
): Promise<string> {
  const dir = join(sourceDir, name.replace("/", "--"));
  await mkdir(dir, { recursive: true });
  const lines = [
    "---",
    `name: ${name}`,
    `description: Skill ${name}`,
    ...(deps
      ? [
          `dependencies:`,
          ...(deps.skills ? [`  skills:`, ...deps.skills.map((s) => `    - ${s}`)] : []),
          ...(deps.mcps ? [`  mcps:`, ...deps.mcps.map((m) => `    - ${m}`)] : []),
        ]
      : []),
    "---",
  ].join("\n");
  await writeFile(join(dir, "SKILL.md"), lines);
  return dir;
}

async function makeAgent(
  name: string,
  deps?: { skills?: string[]; mcps?: string[] },
): Promise<string> {
  const dir = join(sourceDir, `agent-${name.replace("/", "--")}`);
  await mkdir(dir, { recursive: true });
  const lines = [
    "---",
    `name: ${name}`,
    `description: Agent ${name}`,
    ...(deps
      ? [
          `dependencies:`,
          ...(deps.skills ? [`  skills:`, ...deps.skills.map((s) => `    - ${s}`)] : []),
          ...(deps.mcps ? [`  mcps:`, ...deps.mcps.map((m) => `    - ${m}`)] : []),
        ]
      : []),
    "---",
  ].join("\n");
  await writeFile(join(dir, "AGENTS.md"), lines);
  return dir;
}

async function makeMcp(name: string): Promise<string> {
  const file = join(sourceDir, `${name}.json`);
  await writeFile(file, JSON.stringify({ type: "stdio", command: name }));
  return file;
}

beforeEach(async () => {
  const base = join(tmpdir(), `resolver-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  catalogDir = join(base, "catalog");
  sourceDir = join(base, "source");
  await mkdir(catalogDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  skills = new SkillStore(catalogDir);
  agents = new AgentStore(catalogDir);
  mcps = new McpStore(catalogDir);
  resolver = new Resolver(skills, agents, mcps, catalogDir);
});

afterEach(async () => {
  await rm(join(catalogDir, ".."), { recursive: true, force: true });
});

describe("Resolver", () => {
  it("resolves agent with direct deps", async () => {
    await mcps.install(await makeMcp("github"));
    await skills.install(await makeSkill("lint"));
    await agents.install(await makeAgent("reviewer", { skills: ["lint"], mcps: ["github"] }));

    const result = resolver.resolve("reviewer");
    expect(result.entry.kind).toBe("agent");
    expect(result.skills.map((s) => s.skill.name)).toEqual(["lint"]);
    expect(result.mcps.map((m) => m.name)).toEqual(["github"]);
  });

  it("resolves skill with direct deps", async () => {
    await mcps.install(await makeMcp("semgrep"));
    await skills.install(await makeSkill("cve-db"));
    await skills.install(
      await makeSkill("security-audit", { skills: ["cve-db"], mcps: ["semgrep"] }),
    );

    const result = resolver.resolve("security-audit");
    expect(result.entry.kind).toBe("skill");
    expect(result.skills.map((s) => s.skill.name)).toContain("cve-db");
    expect(result.mcps.map((m) => m.name)).toContain("semgrep");
  });

  it("resolves transitive dependencies in topological order", async () => {
    await mcps.install(await makeMcp("db"));
    await skills.install(await makeSkill("leaf"));
    await skills.install(await makeSkill("mid", { skills: ["leaf"], mcps: ["db"] }));
    await agents.install(await makeAgent("top", { skills: ["mid"] }));

    const result = resolver.resolve("top");
    const names = result.skills.map((s) => s.skill.name);
    expect(names).toContain("leaf");
    expect(names).toContain("mid");
    expect(names.indexOf("leaf")).toBeLessThan(names.indexOf("mid"));
    expect(result.mcps.map((m) => m.name)).toContain("db");
  });

  it("includes entry path", async () => {
    await agents.install(await makeAgent("reviewer"));
    const result = resolver.resolve("reviewer");
    expect(result.entry.path).toContain(join("agents", "reviewer"));
  });

  it("throws for unknown name", () => {
    expect(() => resolver.resolve("nope")).toThrow("not found in catalog");
  });

  it("resolves agent with no deps", async () => {
    await agents.install(await makeAgent("simple"));
    const result = resolver.resolve("simple");
    expect(result.skills).toHaveLength(0);
    expect(result.mcps).toHaveLength(0);
    expect(result.entry.kind).toBe("agent");
  });
});
