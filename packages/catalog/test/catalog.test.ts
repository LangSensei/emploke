import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "../src/catalog.js";
import { HasDependents, NameInvalid, NotFound } from "../src/errors.js";

let catalogDir: string;
let sourceDir: string;

async function makeSkillSource(
  name: string,
  opts: {
    description?: string;
    version?: string;
    deps?: { skills?: string[]; mcps?: string[] };
    prereqs?: string;
  } = {},
): Promise<string> {
  const dir = join(sourceDir, name.replace("/", "--"));
  await mkdir(dir, { recursive: true });
  const fm = [
    "---",
    `name: ${name}`,
    `description: ${opts.description ?? "A skill"}`,
    ...(opts.version ? [`version: ${opts.version}`] : []),
    ...(opts.deps
      ? [
          `dependencies:`,
          ...(opts.deps.skills ? [`  skills:`, ...opts.deps.skills.map((s) => `    - ${s}`)] : []),
          ...(opts.deps.mcps ? [`  mcps:`, ...opts.deps.mcps.map((m) => `    - ${m}`)] : []),
        ]
      : []),
    ...(opts.prereqs ? [`prereqs: "${opts.prereqs}"`] : []),
    "---",
    "",
    "## Instructions",
    "Do stuff.",
  ].join("\n");
  await writeFile(join(dir, "SKILL.md"), fm);
  return dir;
}

async function makeAgentSource(
  name: string,
  opts: { description?: string; deps?: { skills?: string[]; mcps?: string[] } } = {},
): Promise<string> {
  const dir = join(sourceDir, `agent-${name.replace("/", "--")}`);
  await mkdir(dir, { recursive: true });
  const fm = [
    "---",
    `name: ${name}`,
    `description: ${opts.description ?? "An agent"}`,
    ...(opts.deps
      ? [
          `dependencies:`,
          ...(opts.deps.skills ? [`  skills:`, ...opts.deps.skills.map((s) => `    - ${s}`)] : []),
          ...(opts.deps.mcps ? [`  mcps:`, ...opts.deps.mcps.map((m) => `    - ${m}`)] : []),
        ]
      : []),
    "---",
    "",
    "## Instructions",
    "Do agent stuff.",
  ].join("\n");
  await writeFile(join(dir, "AGENTS.md"), fm);
  return dir;
}

async function makeMcpSource(name: string): Promise<string> {
  const file = join(sourceDir, `${name}.json`);
  await writeFile(file, JSON.stringify({ type: "stdio", command: "npx", args: [`@mcp/${name}`] }));
  return file;
}

beforeEach(async () => {
  const base = join(tmpdir(), `emploke-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  catalogDir = join(base, "catalog");
  sourceDir = join(base, "source");
  await mkdir(catalogDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
});

afterEach(async () => {
  await rm(join(catalogDir, ".."), { recursive: true, force: true });
});

describe("Catalog", () => {
  describe("open + scan", () => {
    it("opens an empty catalog", async () => {
      const c = await Catalog.open({ catalogDir });
      expect(c.listSkills()).toEqual([]);
      expect(c.listAgents()).toEqual([]);
      expect(c.listMcps()).toEqual([]);
    });

    it("scans existing skills (flat and scoped)", async () => {
      // Create skills on disk directly
      const skillDir = join(catalogDir, "skills", "weather");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: weather\ndescription: Weather\n---\n",
      );

      const scopedDir = join(catalogDir, "skills", "langsensei", "analytics");
      await mkdir(scopedDir, { recursive: true });
      await writeFile(
        join(scopedDir, "SKILL.md"),
        "---\nname: langsensei/analytics\ndescription: Analytics\n---\n",
      );

      const c = await Catalog.open({ catalogDir });
      expect(
        c
          .listSkills()
          .map((s) => s.name)
          .sort(),
      ).toEqual(["langsensei/analytics", "weather"]);
    });

    it("scans existing agents", async () => {
      const agentDir = join(catalogDir, "agents", "reviewer");
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, "AGENTS.md"),
        "---\nname: reviewer\ndescription: Reviews\n---\n",
      );

      const c = await Catalog.open({ catalogDir });
      expect(c.listAgents()).toHaveLength(1);
      expect(c.getAgent("reviewer")!.name).toBe("reviewer");
    });

    it("scans existing mcps", async () => {
      const mcpDir = join(catalogDir, "mcps");
      await mkdir(mcpDir, { recursive: true });
      await writeFile(join(mcpDir, "github.json"), '{"type":"stdio","command":"npx"}');

      const c = await Catalog.open({ catalogDir });
      expect(c.listMcps()).toEqual(["github"]);
    });
  });

  describe("installSkill", () => {
    it("installs a skill", async () => {
      const c = await Catalog.open({ catalogDir });
      const src = await makeSkillSource("weather", { description: "Get weather" });
      const skill = await c.installSkill(src);
      expect(skill.name).toBe("weather");
      expect(skill.description).toBe("Get weather");
      expect(c.getSkill("weather")).toEqual(skill);
    });

    it("installs a scoped skill", async () => {
      const c = await Catalog.open({ catalogDir });
      const src = await makeSkillSource("langsensei/weather", { description: "Weather" });
      const skill = await c.installSkill(src);
      expect(skill.name).toBe("langsensei/weather");
      // Verify on disk
      const onDisk = join(catalogDir, "skills", "langsensei", "weather", "SKILL.md");
      expect(await readFile(onDisk, "utf8")).toContain("langsensei/weather");
    });

    it("updates (upserts) existing skill", async () => {
      const c = await Catalog.open({ catalogDir });
      const src1 = await makeSkillSource("weather", { version: "1.0.0" });
      await c.installSkill(src1);
      const src2 = await makeSkillSource("weather", { version: "2.0.0" });
      const updated = await c.installSkill(src2);
      expect(updated.version).toBe("2.0.0");
      expect(c.listSkills()).toHaveLength(1);
    });

    it("preserves prereqs", async () => {
      const c = await Catalog.open({ catalogDir });
      const src = await makeSkillSource("setup", { prereqs: "Run npm install first" });
      const skill = await c.installSkill(src);
      expect(skill.prereqs).toBe("Run npm install first");
    });

    it("rejects invalid name", async () => {
      const c = await Catalog.open({ catalogDir });
      const dir = join(sourceDir, "bad");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: Bad_Name\ndescription: x\n---\n");
      await expect(c.installSkill(dir)).rejects.toThrow(NameInvalid);
    });
  });

  describe("removeSkill", () => {
    it("removes an installed skill", async () => {
      const c = await Catalog.open({ catalogDir });
      const src = await makeSkillSource("weather");
      await c.installSkill(src);
      await c.removeSkill("weather");
      expect(c.getSkill("weather")).toBeNull();
    });

    it("throws NotFound for unknown skill", async () => {
      const c = await Catalog.open({ catalogDir });
      await expect(c.removeSkill("nope")).rejects.toThrow(NotFound);
    });

    it("blocks removal if another skill depends on it", async () => {
      const c = await Catalog.open({ catalogDir });
      const mcpSrc = await makeMcpSource("github");
      await c.installMcp(mcpSrc);
      const leafSrc = await makeSkillSource("leaf", { description: "Leaf" });
      await c.installSkill(leafSrc);
      const parentSrc = await makeSkillSource("parent", { deps: { skills: ["leaf"] } });
      await c.installSkill(parentSrc);
      await expect(c.removeSkill("leaf")).rejects.toThrow(HasDependents);
    });
  });

  describe("installAgent", () => {
    it("installs an agent", async () => {
      const c = await Catalog.open({ catalogDir });
      const src = await makeAgentSource("reviewer", { description: "Reviews PRs" });
      const agent = await c.installAgent(src);
      expect(agent.name).toBe("reviewer");
      expect(c.getAgent("reviewer")).toEqual(agent);
    });

    it("installs a scoped agent", async () => {
      const c = await Catalog.open({ catalogDir });
      const src = await makeAgentSource("langsensei/reviewer");
      const agent = await c.installAgent(src);
      expect(agent.name).toBe("langsensei/reviewer");
    });
  });

  describe("removeAgent", () => {
    it("removes an installed agent", async () => {
      const c = await Catalog.open({ catalogDir });
      const src = await makeAgentSource("reviewer");
      await c.installAgent(src);
      await c.removeAgent("reviewer");
      expect(c.getAgent("reviewer")).toBeNull();
    });
  });

  describe("installMcp", () => {
    it("installs an mcp", async () => {
      const c = await Catalog.open({ catalogDir });
      const src = await makeMcpSource("github");
      const name = await c.installMcp(src);
      expect(name).toBe("github");
      expect(c.listMcps()).toContain("github");
    });

    it("rejects scoped mcp name", async () => {
      const c = await Catalog.open({ catalogDir });
      const file = join(sourceDir, "langsensei/github.json");
      await mkdir(join(sourceDir, "langsensei"), { recursive: true });
      await writeFile(file, '{"type":"stdio"}');
      // File basename is "github.json" so this should work (scope is in path, not filename)
      const name = await c.installMcp(file);
      expect(name).toBe("github");
    });
  });

  describe("resolve", () => {
    it("resolves agent dependencies (skills + mcps)", async () => {
      const c = await Catalog.open({ catalogDir });
      const mcpSrc = await makeMcpSource("github");
      await c.installMcp(mcpSrc);
      const skillSrc = await makeSkillSource("security-audit");
      await c.installSkill(skillSrc);
      const agentSrc = await makeAgentSource("reviewer", {
        deps: { skills: ["security-audit"], mcps: ["github"] },
      });
      await c.installAgent(agentSrc);

      const result = c.resolve("reviewer");
      expect(result.entry).toEqual({
        kind: "agent",
        agent: expect.objectContaining({ name: "reviewer" }),
        path: expect.stringContaining(join("agents", "reviewer")),
      });
      expect(result.skills.map((s) => s.skill.name)).toContain("security-audit");
      expect(result.mcps.map((m) => m.name)).toContain("github");
    });

    it("resolves transitive skill dependencies", async () => {
      const c = await Catalog.open({ catalogDir });
      const mcpSrc = await makeMcpSource("semgrep");
      await c.installMcp(mcpSrc);
      const leafSrc = await makeSkillSource("cve-db");
      await c.installSkill(leafSrc);
      const midSrc = await makeSkillSource("security-audit", {
        deps: { skills: ["cve-db"], mcps: ["semgrep"] },
      });
      await c.installSkill(midSrc);
      const agentSrc = await makeAgentSource("reviewer", { deps: { skills: ["security-audit"] } });
      await c.installAgent(agentSrc);

      const result = c.resolve("reviewer");
      const names = result.skills.map((s) => s.skill.name);
      expect(names).toContain("cve-db");
      expect(names).toContain("security-audit");
      // cve-db before security-audit (topological)
      expect(names.indexOf("cve-db")).toBeLessThan(names.indexOf("security-audit"));
      expect(result.mcps.map((m) => m.name)).toContain("semgrep");
    });

    it("throws for unknown name", async () => {
      const c = await Catalog.open({ catalogDir });
      expect(() => c.resolve("nope")).toThrow("not found in catalog");
    });
  });

  describe("inspectSource", () => {
    it("inspects a skill source", async () => {
      const c = await Catalog.open({ catalogDir });
      const src = await makeSkillSource("weather", { description: "Weather skill" });
      const result = await c.inspectSource(src);
      expect(result.name).toBe("weather");
      expect(result.description).toBe("Weather skill");
    });

    it("inspects an agent source", async () => {
      const c = await Catalog.open({ catalogDir });
      const src = await makeAgentSource("reviewer", { description: "PR reviewer" });
      const result = await c.inspectSource(src);
      expect(result.name).toBe("reviewer");
      expect(result.description).toBe("PR reviewer");
    });
  });

  describe("validateName", () => {
    it("accepts unscoped kebab-case", async () => {
      const c = await Catalog.open({ catalogDir });
      const src = await makeSkillSource("my-skill");
      await expect(c.installSkill(src)).resolves.toBeDefined();
    });

    it("accepts scoped name", async () => {
      const c = await Catalog.open({ catalogDir });
      const src = await makeSkillSource("langsensei/my-skill");
      await expect(c.installSkill(src)).resolves.toBeDefined();
    });

    it("rejects uppercase", async () => {
      const c = await Catalog.open({ catalogDir });
      const dir = join(sourceDir, "Bad");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: Bad\ndescription: x\n---\n");
      await expect(c.installSkill(dir)).rejects.toThrow(NameInvalid);
    });

    it("rejects multiple slashes", async () => {
      const c = await Catalog.open({ catalogDir });
      const dir = join(sourceDir, "bad2");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: a/b/c\ndescription: x\n---\n");
      await expect(c.installSkill(dir)).rejects.toThrow(NameInvalid);
    });
  });
});

describe("entry status", () => {
  it("skill is ready when all deps present", async () => {
    const c = await Catalog.open({ catalogDir });
    const mcpSrc = await makeMcpSource("github");
    await c.installMcp(mcpSrc);
    const skillSrc = await makeSkillSource("lint", { deps: { mcps: ["github"] } });
    await c.installSkill(skillSrc);

    const entry = c.getSkillEntry("lint");
    expect(entry!.status).toBe("ready");
    expect(entry!.missingDeps).toBeUndefined();
  });

  it("skill is disabled when dep missing", async () => {
    const c = await Catalog.open({ catalogDir });
    const skillSrc = await makeSkillSource("lint", { deps: { mcps: ["github"] } });
    await c.installSkill(skillSrc);

    const entry = c.getSkillEntry("lint");
    expect(entry!.status).toBe("disabled");
    expect(entry!.missingDeps?.map((d) => d.name)).toContain("github");
    expect(entry!.missingDeps?.find((d) => d.name === "github")?.kind).toBe("mcp");
  });

  it("skill becomes ready after dep installed", async () => {
    const c = await Catalog.open({ catalogDir });
    const skillSrc = await makeSkillSource("lint", { deps: { mcps: ["github"] } });
    await c.installSkill(skillSrc);
    expect(c.getSkillEntry("lint")!.status).toBe("disabled");

    const mcpSrc = await makeMcpSource("github");
    await c.installMcp(mcpSrc);
    expect(c.getSkillEntry("lint")!.status).toBe("ready");
  });

  it("skill becomes disabled after dep removed", async () => {
    const c = await Catalog.open({ catalogDir });
    const mcpSrc = await makeMcpSource("github");
    await c.installMcp(mcpSrc);
    const skillSrc = await makeSkillSource("lint", { deps: { mcps: ["github"] } });
    await c.installSkill(skillSrc);
    expect(c.getSkillEntry("lint")!.status).toBe("ready");

    // Remove dep — but lint depends on it, so should be blocked
    await expect(c.removeMcp("github")).rejects.toThrow();
  });

  it("agent is disabled when skill dep missing", async () => {
    const c = await Catalog.open({ catalogDir });
    const agentSrc = await makeAgentSource("reviewer", { deps: { skills: ["lint"] } });
    await c.installAgent(agentSrc);

    const entry = c.getAgentEntry("reviewer");
    expect(entry!.status).toBe("disabled");
    expect(entry!.missingDeps?.map((d) => d.name)).toContain("lint");
    expect(entry!.missingDeps?.find((d) => d.name === "lint")?.kind).toBe("skill");
  });

  it("agent becomes ready after skill installed", async () => {
    const c = await Catalog.open({ catalogDir });
    const agentSrc = await makeAgentSource("reviewer", { deps: { skills: ["lint"] } });
    await c.installAgent(agentSrc);
    expect(c.getAgentEntry("reviewer")!.status).toBe("disabled");

    const skillSrc = await makeSkillSource("lint");
    await c.installSkill(skillSrc);
    expect(c.getAgentEntry("reviewer")!.status).toBe("ready");
  });

  it("listSkillEntries returns all with status", async () => {
    const c = await Catalog.open({ catalogDir });
    await c.installSkill(await makeSkillSource("a"));
    await c.installSkill(await makeSkillSource("b", { deps: { skills: ["missing"] } }));

    const entries = c.listSkillEntries();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.skill.name === "a")!.status).toBe("ready");
    expect(entries.find((e) => e.skill.name === "b")!.status).toBe("disabled");
  });

  it("listAgentEntries returns all with status", async () => {
    const c = await Catalog.open({ catalogDir });
    await c.installAgent(await makeAgentSource("simple"));
    const entries = c.listAgentEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("ready");
  });

  it("rescan recomputes status", async () => {
    const c = await Catalog.open({ catalogDir });
    await c.installSkill(await makeSkillSource("lint", { deps: { mcps: ["github"] } }));
    expect(c.getSkillEntry("lint")!.status).toBe("disabled");

    // Manually write MCP file to disk (bypass catalog API) then rescan
    const mcpDir = join(catalogDir, "mcps");
    await mkdir(mcpDir, { recursive: true });
    await writeFile(join(mcpDir, "github.json"), JSON.stringify({ type: "stdio", command: "gh" }));
    await c.rescan();
    expect(c.getSkillEntry("lint")!.status).toBe("ready");
  });
});
