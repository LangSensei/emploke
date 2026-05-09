import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HasDependents, NameInvalid, NotFound } from "../src/errors.js";
import { CatalogManager } from "../src/manager.js";
import {
  dep,
  makeAgentSource,
  makeBase,
  makeMcpSource,
  makeSkillSource,
  type MakeSourceOpts,
} from "./helpers.js";

let catalogDir: string;
let sourceDir: string;

async function makeSkill(name: string, opts: MakeSourceOpts = {}): Promise<string> {
  return makeSkillSource(sourceDir, name, opts);
}
async function makeAgent(name: string, opts: MakeSourceOpts = {}): Promise<string> {
  return makeAgentSource(sourceDir, name, opts);
}
async function makeMcp(name: string): Promise<string> {
  return makeMcpSource(sourceDir, name);
}

beforeEach(async () => {
  const base = makeBase("emploke-test");
  catalogDir = join(base, "catalog");
  sourceDir = join(base, "source");
  await mkdir(catalogDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
});

afterEach(async () => {
  await rm(join(catalogDir, ".."), { recursive: true, force: true });
});

describe("CatalogManager", () => {
  describe("open + scan", () => {
    it("opens an empty catalog", async () => {
      const c = await CatalogManager.open({ catalogDir });
      expect(c.listSkills()).toEqual([]);
      expect(c.listAgents()).toEqual([]);
      expect(c.listMcps()).toEqual([]);
    });

    it("scans existing skills (legacy unscoped flat folder + scoped)", async () => {
      // Legacy unscoped skill: scope = local, name = local/weather
      const skillDir = join(catalogDir, "skills", "local", "weather");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: weather\ndescription: Weather\n---\n",
      );

      const scopedDir = join(catalogDir, "skills", "langsensei", "analytics");
      await mkdir(scopedDir, { recursive: true });
      await writeFile(
        join(scopedDir, "SKILL.md"),
        "---\nname: analytics\nscope: langsensei\ndescription: Analytics\n---\n",
      );

      const c = await CatalogManager.open({ catalogDir });
      expect(
        c
          .listSkills()
          .map((s) => s.name)
          .sort(),
      ).toEqual(["langsensei/analytics", "local/weather"]);
    });

    it("scans existing agents", async () => {
      const agentDir = join(catalogDir, "agents", "local", "reviewer");
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, "AGENTS.md"),
        "---\nname: reviewer\ndescription: Reviews\n---\n",
      );

      const c = await CatalogManager.open({ catalogDir });
      expect(c.listAgents()).toHaveLength(1);
      expect(c.getAgent("local/reviewer")!.name).toBe("local/reviewer");
    });

    it("scans existing mcps (legacy unscoped → local/)", async () => {
      const mcpDir = join(catalogDir, "mcps");
      await mkdir(mcpDir, { recursive: true });
      await writeFile(join(mcpDir, "github.json"), '{"type":"stdio","command":"npx"}');

      const c = await CatalogManager.open({ catalogDir });
      expect(c.listMcps()).toEqual(["local/github"]);
    });
  });

  describe("installSkill", () => {
    it("installs a skill (FQN local/<name>)", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeSkill("weather", { description: "Get weather" });
      const skill = await c.installSkill(src);
      expect(skill.name).toBe("local/weather");
      expect(skill.description).toBe("Get weather");
      expect(c.getSkill("local/weather")).toEqual(skill);
    });

    it("installs a scoped skill via frontmatter scope:", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeSkill("weather", {
        scope: "langsensei",
        description: "Weather",
      });
      const skill = await c.installSkill(src);
      expect(skill.name).toBe("langsensei/weather");
      const onDisk = join(catalogDir, "skills", "langsensei", "weather", "SKILL.md");
      expect(await readFile(onDisk, "utf8")).toContain("langsensei");
    });

    it("updates (upserts) existing skill", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src1 = await makeSkill("weather", { version: "1.0.0" });
      await c.installSkill(src1);
      const src2 = await makeSkill("weather", { version: "2.0.0" });
      const updated = await c.installSkill(src2);
      expect(updated.version).toBe("2.0.0");
      expect(c.listSkills()).toHaveLength(1);
    });

    it("preserves prereqs", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeSkill("setup", { prereqs: "Run setup.sh first" });
      const skill = await c.installSkill(src);
      expect(skill.prereqs).toBe("Run setup.sh first");
    });

    it("rejects invalid name", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const dir = join(sourceDir, "bad");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: Bad_Name\ndescription: x\n---\n");
      await expect(c.installSkill(dir)).rejects.toThrow(NameInvalid);
    });
  });

  describe("removeSkill", () => {
    it("removes an installed skill", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeSkill("weather");
      await c.installSkill(src);
      await c.removeSkill("local/weather");
      expect(c.getSkill("local/weather")).toBeNull();
    });

    it("throws NotFound for unknown skill", async () => {
      const c = await CatalogManager.open({ catalogDir });
      await expect(c.removeSkill("local/nope")).rejects.toThrow(NotFound);
    });

    it("blocks removal if another skill depends on it", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const mcpSrc = await makeMcp("github");
      await c.installMcp(mcpSrc);
      const leafSrc = await makeSkill("leaf", { description: "Leaf" });
      await c.installSkill(leafSrc);
      const parentSrc = await makeSkill("parent", { deps: { skills: [dep("leaf")] } });
      await c.installSkill(parentSrc);
      await expect(c.removeSkill("local/leaf")).rejects.toThrow(HasDependents);
    });
  });

  describe("installAgent", () => {
    it("installs an agent", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeAgent("reviewer", { description: "Reviews PRs" });
      const agent = await c.installAgent(src);
      expect(agent.name).toBe("local/reviewer");
      expect(c.getAgent("local/reviewer")).toEqual(agent);
    });

    it("installs a scoped agent via frontmatter scope:", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeAgent("reviewer", { scope: "langsensei" });
      const agent = await c.installAgent(src);
      expect(agent.name).toBe("langsensei/reviewer");
    });
  });

  describe("removeAgent", () => {
    it("removes an installed agent", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeAgent("reviewer");
      await c.installAgent(src);
      await c.removeAgent("local/reviewer");
      expect(c.getAgent("local/reviewer")).toBeNull();
    });
  });

  describe("installMcp", () => {
    it("installs an mcp", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeMcp("github");
      const fqn = await c.installMcp(src);
      expect(fqn).toBe("local/github");
      expect(c.listMcps()).toContain("local/github");
    });

    it("installs an mcp from a path that contains a directory segment", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const file = join(sourceDir, "langsensei/github.json");
      await mkdir(join(sourceDir, "langsensei"), { recursive: true });
      await writeFile(file, '{"type":"stdio"}');
      const fqn = await c.installMcp(file);
      expect(fqn).toBe("local/github");
    });
  });

  describe("resolveAgent / resolveSkill", () => {
    it("resolveAgent: returns agent + transitive deps", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const mcpSrc = await makeMcp("github");
      await c.installMcp(mcpSrc);
      const skillSrc = await makeSkill("security-audit");
      await c.installSkill(skillSrc);
      const agentSrc = await makeAgent("reviewer", {
        deps: { skills: [dep("security-audit")], mcps: [dep("github")] },
      });
      await c.installAgent(agentSrc);

      const result = c.resolveAgent("local/reviewer");
      expect(result.agent.name).toBe("local/reviewer");
      expect(result.skills.map((s) => s.skill.name)).toContain("local/security-audit");
      expect(result.mcps.map((m) => m.name)).toContain("local/github");
    });

    it("resolveAgent: transitive skill dependencies in topological order", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const mcpSrc = await makeMcp("semgrep");
      await c.installMcp(mcpSrc);
      const leafSrc = await makeSkill("cve-db");
      await c.installSkill(leafSrc);
      const midSrc = await makeSkill("security-audit", {
        deps: { skills: [dep("cve-db")], mcps: [dep("semgrep")] },
      });
      await c.installSkill(midSrc);
      const agentSrc = await makeAgent("reviewer", {
        deps: { skills: [dep("security-audit")] },
      });
      await c.installAgent(agentSrc);

      const result = c.resolveAgent("local/reviewer");
      const names = result.skills.map((s) => s.skill.name);
      expect(names).toContain("local/cve-db");
      expect(names).toContain("local/security-audit");
      expect(names.indexOf("local/cve-db")).toBeLessThan(names.indexOf("local/security-audit"));
      expect(result.mcps.map((m) => m.name)).toContain("local/semgrep");
    });

    it("resolveSkill: includes the entry skill itself in skills[]", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const mcpSrc = await makeMcp("semgrep");
      await c.installMcp(mcpSrc);
      const leafSrc = await makeSkill("cve-db");
      await c.installSkill(leafSrc);
      const midSrc = await makeSkill("security-audit", {
        deps: { skills: [dep("cve-db")], mcps: [dep("semgrep")] },
      });
      await c.installSkill(midSrc);

      const result = c.resolveSkill("local/security-audit");
      expect(result.skill.name).toBe("local/security-audit");
      const names = result.skills.map((s) => s.skill.name);
      expect(names).toEqual(["local/cve-db", "local/security-audit"]);
      expect(result.mcps.map((m) => m.name)).toContain("local/semgrep");
    });

    it("throws for unknown name", async () => {
      const c = await CatalogManager.open({ catalogDir });
      expect(() => c.resolveAgent("local/nope")).toThrow("agent not found in catalog");
      expect(() => c.resolveSkill("local/nope")).toThrow("skill not found in catalog");
    });
  });

  describe("inspectSource", () => {
    it("inspects a skill source", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeSkill("weather", { description: "Weather skill" });
      const result = await c.inspectSource(src);
      expect(result.name).toBe("local/weather");
      expect(result.description).toBe("Weather skill");
    });

    it("inspects an agent source", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeAgent("reviewer", { description: "PR reviewer" });
      const result = await c.inspectSource(src);
      expect(result.name).toBe("local/reviewer");
      expect(result.description).toBe("PR reviewer");
    });
  });

  describe("name validation", () => {
    it("accepts unscoped kebab-case (becomes local/<name>)", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeSkill("my-skill");
      await expect(c.installSkill(src)).resolves.toBeDefined();
    });

    it("accepts explicit scope via frontmatter", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeSkill("my-skill", { scope: "langsensei" });
      await expect(c.installSkill(src)).resolves.toBeDefined();
    });

    it("rejects uppercase short name", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const dir = join(sourceDir, "bad");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: Bad\ndescription: x\n---\n");
      await expect(c.installSkill(dir)).rejects.toThrow(NameInvalid);
    });

    it("rejects slashes in the short-name field", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const dir = join(sourceDir, "bad2");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: a/b\ndescription: x\n---\n");
      await expect(c.installSkill(dir)).rejects.toThrow();
    });
  });
});

describe("entry status", () => {
  it("skill is ready when all deps present", async () => {
    const c = await CatalogManager.open({ catalogDir });
    const mcpSrc = await makeMcp("github");
    await c.installMcp(mcpSrc);
    const skillSrc = await makeSkill("lint", { deps: { mcps: [dep("github")] } });
    await c.installSkill(skillSrc);

    const entry = c.getSkillEntry("local/lint");
    expect(entry!.status).toBe("ready");
    expect(entry!.missingDeps).toBeUndefined();
  });

  it("skill is disabled when dep missing", async () => {
    const c = await CatalogManager.open({ catalogDir });
    const skillSrc = await makeSkill("lint", { deps: { mcps: [dep("github")] } });
    await c.installSkill(skillSrc);

    const entry = c.getSkillEntry("local/lint");
    expect(entry!.status).toBe("disabled");
    expect(entry!.missingDeps?.map((d) => d.name)).toContain("local/github");
    expect(entry!.missingDeps?.find((d) => d.name === "local/github")?.kind).toBe("mcp");
  });

  it("skill becomes ready after dep installed", async () => {
    const c = await CatalogManager.open({ catalogDir });
    const skillSrc = await makeSkill("lint", { deps: { mcps: [dep("github")] } });
    await c.installSkill(skillSrc);
    expect(c.getSkillEntry("local/lint")!.status).toBe("disabled");

    const mcpSrc = await makeMcp("github");
    await c.installMcp(mcpSrc);
    expect(c.getSkillEntry("local/lint")!.status).toBe("ready");
  });

  it("skill becomes disabled after dep removed", async () => {
    const c = await CatalogManager.open({ catalogDir });
    const mcpSrc = await makeMcp("github");
    await c.installMcp(mcpSrc);
    const skillSrc = await makeSkill("lint", { deps: { mcps: [dep("github")] } });
    await c.installSkill(skillSrc);
    expect(c.getSkillEntry("local/lint")!.status).toBe("ready");

    // Remove dep — but lint depends on it, so should be blocked
    await expect(c.removeMcp("local/github")).rejects.toThrow();
  });

  it("agent is disabled when skill dep missing", async () => {
    const c = await CatalogManager.open({ catalogDir });
    const agentSrc = await makeAgent("reviewer", { deps: { skills: [dep("lint")] } });
    await c.installAgent(agentSrc);

    const entry = c.getAgentEntry("local/reviewer");
    expect(entry!.status).toBe("disabled");
    expect(entry!.missingDeps?.map((d) => d.name)).toContain("local/lint");
    expect(entry!.missingDeps?.find((d) => d.name === "local/lint")?.kind).toBe("skill");
  });

  it("agent becomes ready after skill installed", async () => {
    const c = await CatalogManager.open({ catalogDir });
    const agentSrc = await makeAgent("reviewer", { deps: { skills: [dep("lint")] } });
    await c.installAgent(agentSrc);
    expect(c.getAgentEntry("local/reviewer")!.status).toBe("disabled");

    const skillSrc = await makeSkill("lint");
    await c.installSkill(skillSrc);
    expect(c.getAgentEntry("local/reviewer")!.status).toBe("ready");
  });

  it("listSkillEntries returns all with status", async () => {
    const c = await CatalogManager.open({ catalogDir });
    await c.installSkill(await makeSkill("a"));
    await c.installSkill(await makeSkill("b", { deps: { skills: [dep("missing")] } }));

    const entries = c.listSkillEntries();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.skill.name === "local/a")!.status).toBe("ready");
    expect(entries.find((e) => e.skill.name === "local/b")!.status).toBe("disabled");
  });

  it("listAgentEntries returns all with status", async () => {
    const c = await CatalogManager.open({ catalogDir });
    await c.installAgent(await makeAgent("simple"));
    const entries = c.listAgentEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("ready");
  });

  it("rescan recomputes status", async () => {
    const c = await CatalogManager.open({ catalogDir });
    await c.installSkill(await makeSkill("lint", { deps: { mcps: [dep("github")] } }));
    expect(c.getSkillEntry("local/lint")!.status).toBe("disabled");

    // Manually write MCP file to disk under local/ scope then rescan
    const mcpDir = join(catalogDir, "mcps", "local");
    await mkdir(mcpDir, { recursive: true });
    await writeFile(join(mcpDir, "github.json"), JSON.stringify({ type: "stdio", command: "gh" }));
    await c.rescan();
    expect(c.getSkillEntry("local/lint")!.status).toBe("ready");
  });

  describe("rescanIfStale", () => {
    it("skips scan when not stale", async () => {
      const c = await CatalogManager.open({ catalogDir });
      // open() already runs an initial scan, so _lastScanAt is fresh.
      const spy = vi.spyOn(c, "rescan");
      await c.rescanIfStale(60_000);
      expect(spy).not.toHaveBeenCalled();
    });

    it("triggers scan when stale", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const spy = vi.spyOn(c, "rescan");
      // maxAgeMs=-1 makes any elapsed time count as stale.
      await c.rescanIfStale(-1);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("coalesces concurrent stale calls into a single scan (single-flight)", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const spy = vi.spyOn(c, "rescan");
      // Fire 4 parallel calls — without single-flight all 4 would scan.
      await Promise.all([
        c.rescanIfStale(-1),
        c.rescanIfStale(-1),
        c.rescanIfStale(-1),
        c.rescanIfStale(-1),
      ]);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("clears the in-flight slot so the next stale call scans again", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const spy = vi.spyOn(c, "rescan");
      await c.rescanIfStale(-1);
      await c.rescanIfStale(-1);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("propagates rescan errors and clears the in-flight slot", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const boom = new Error("disk on fire");
      const spy = vi.spyOn(c, "rescan").mockRejectedValueOnce(boom);
      await expect(c.rescanIfStale(-1)).rejects.toThrow("disk on fire");
      // Slot must be cleared even on failure so subsequent calls aren't stuck.
      spy.mockRestore();
      const spy2 = vi.spyOn(c, "rescan");
      await c.rescanIfStale(-1);
      expect(spy2).toHaveBeenCalledTimes(1);
    });
  });
});
