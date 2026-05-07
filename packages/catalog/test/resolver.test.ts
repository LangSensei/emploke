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
  it("resolveAgent: agent with direct deps", async () => {
    await mcps.install(await makeMcp("github"));
    await skills.install(await makeSkill("lint"));
    await agents.install(await makeAgent("reviewer", { skills: ["lint"], mcps: ["github"] }));

    const result = resolver.resolveAgent("reviewer");
    expect(result.agent.name).toBe("reviewer");
    expect(result.agentPath).toContain(join("agents", "reviewer"));
    expect(result.skills.map((s) => s.skill.name)).toEqual(["lint"]);
    expect(result.mcps.map((m) => m.name)).toEqual(["github"]);
  });

  it("resolveSkill: skill with direct deps; entry skill is included in skills[]", async () => {
    await mcps.install(await makeMcp("semgrep"));
    await skills.install(await makeSkill("cve-db"));
    await skills.install(
      await makeSkill("security-audit", { skills: ["cve-db"], mcps: ["semgrep"] }),
    );

    const result = resolver.resolveSkill("security-audit");
    expect(result.skill.name).toBe("security-audit");
    expect(result.skillPath).toContain(join("skills", "security-audit"));
    const names = result.skills.map((s) => s.skill.name);
    expect(names).toContain("cve-db");
    expect(names).toContain("security-audit");
    // self appears AFTER its deps (topological)
    expect(names.indexOf("cve-db")).toBeLessThan(names.indexOf("security-audit"));
    expect(result.mcps.map((m) => m.name)).toContain("semgrep");
  });

  it("resolveAgent: transitive dependencies in topological order", async () => {
    await mcps.install(await makeMcp("db"));
    await skills.install(await makeSkill("leaf"));
    await skills.install(await makeSkill("mid", { skills: ["leaf"], mcps: ["db"] }));
    await agents.install(await makeAgent("top", { skills: ["mid"] }));

    const result = resolver.resolveAgent("top");
    const names = result.skills.map((s) => s.skill.name);
    expect(names).toContain("leaf");
    expect(names).toContain("mid");
    expect(names.indexOf("leaf")).toBeLessThan(names.indexOf("mid"));
    expect(result.mcps.map((m) => m.name)).toContain("db");
  });

  it("resolveAgent: throws for unknown name", () => {
    expect(() => resolver.resolveAgent("nope")).toThrow("agent not found in catalog");
  });

  it("resolveSkill: throws for unknown name", () => {
    expect(() => resolver.resolveSkill("nope")).toThrow("skill not found in catalog");
  });

  it("resolveAgent: throws helpful error when name is a skill", async () => {
    await skills.install(await makeSkill("a-skill"));
    expect(() => resolver.resolveAgent("a-skill")).toThrow(
      "is a skill, not an agent — use resolveSkill() instead",
    );
  });

  it("resolveSkill: throws helpful error when name is an agent", async () => {
    await agents.install(await makeAgent("an-agent"));
    expect(() => resolver.resolveSkill("an-agent")).toThrow(
      "is an agent, not a skill — use resolveAgent() instead",
    );
  });

  it("resolveAgent: agent with no deps", async () => {
    await agents.install(await makeAgent("simple"));
    const result = resolver.resolveAgent("simple");
    expect(result.skills).toHaveLength(0);
    expect(result.mcps).toHaveLength(0);
    expect(result.agent.name).toBe("simple");
  });

  it("resolveSkill: skill with no deps still returns itself", async () => {
    await skills.install(await makeSkill("standalone"));
    const result = resolver.resolveSkill("standalone");
    expect(result.skills.map((s) => s.skill.name)).toEqual(["standalone"]);
    expect(result.mcps).toHaveLength(0);
  });

  it("rejects an agent listed as a dependency (agents can only depend on others, not be depended on)", async () => {
    await agents.install(await makeAgent("inner-agent"));
    await skills.install(await makeSkill("bad-skill", { skills: ["inner-agent"] }));
    await agents.install(await makeAgent("outer-agent", { skills: ["bad-skill"] }));

    expect(() => resolver.resolveAgent("outer-agent")).toThrow(
      "is an agent and cannot be a dependency",
    );
    expect(() => resolver.resolveSkill("bad-skill")).toThrow(
      "is an agent and cannot be a dependency",
    );
  });
});
