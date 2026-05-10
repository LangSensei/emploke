import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HasDependents, NameInvalid, NotFound } from "../src/errors.js";
import { CatalogManager } from "../src/manager.js";
import {
  dep,
  type MakeSourceOpts,
  makeAgentSource,
  makeBase,
  makeMcpSource,
  makeSkillSource,
  mcpDep,
} from "./helpers.js";

let catalogDir: string;
let sourceDir: string;

async function makeSkill(name: string, opts: MakeSourceOpts = {}): Promise<string> {
  return makeSkillSource(sourceDir, name, opts);
}
async function makeAgent(name: string, opts: MakeSourceOpts = {}): Promise<string> {
  return makeAgentSource(sourceDir, name, opts);
}
async function makeMcp(specName: string): Promise<{ content: string; origin: string }> {
  const file = await makeMcpSource(sourceDir, specName.replace("/", "_"));
  const content = await readFile(file, "utf8");
  return { content, origin: `file:${file}` };
}
async function installMcp(c: CatalogManager, specName: string): Promise<string> {
  const { content, origin } = await makeMcp(specName);
  return c.installMcp(content, { name: specName, origin });
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
      // Legacy unscoped skill: scope = public, name = public/weather
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
      ).toEqual(["langsensei/analytics", "public/weather"]);
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
      expect(c.getAgent("public/reviewer")!.name).toBe("public/reviewer");
    });

    it("scans existing MCPs from two-level layout with inline _meta", async () => {
      const mcpDir = join(catalogDir, "mcps", "github");
      await mkdir(mcpDir, { recursive: true });
      await writeFile(
        join(mcpDir, "cli.json"),
        JSON.stringify({
          command: "gh",
          _meta: { name: "github/cli", origin: "file:/seeded/github/cli.json" },
        }),
      );

      const c = await CatalogManager.open({ catalogDir });
      expect(c.listMcps()).toEqual(["github/cli"]);
    });
  });

  describe("installSkill", () => {
    it("installs a skill (FQN public/<name>)", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeSkill("weather", { description: "Get weather" });
      const skill = await c.installSkill(src);
      expect(skill.name).toBe("public/weather");
      expect(skill.description).toBe("Get weather");
      expect(c.getSkill("public/weather")).toEqual(skill);
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
      await c.removeSkill("public/weather");
      expect(c.getSkill("public/weather")).toBeNull();
    });

    it("throws NotFound for unknown skill", async () => {
      const c = await CatalogManager.open({ catalogDir });
      await expect(c.removeSkill("public/nope")).rejects.toThrow(NotFound);
    });

    it("blocks removal if another skill depends on it", async () => {
      const c = await CatalogManager.open({ catalogDir });
      await installMcp(c, "github/cli");
      const leafSrc = await makeSkill("leaf", { description: "Leaf" });
      await c.installSkill(leafSrc);
      const parentSrc = await makeSkill("parent", { deps: { skills: [dep("leaf")] } });
      await c.installSkill(parentSrc);
      await expect(c.removeSkill("public/leaf")).rejects.toThrow(HasDependents);
    });
  });

  describe("installAgent", () => {
    it("installs an agent", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeAgent("reviewer", { description: "Reviews PRs" });
      const agent = await c.installAgent(src);
      expect(agent.name).toBe("public/reviewer");
      expect(c.getAgent("public/reviewer")).toEqual(agent);
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
      await c.removeAgent("public/reviewer");
      expect(c.getAgent("public/reviewer")).toBeNull();
    });
  });

  describe("installMcp", () => {
    it("installs an mcp under its spec FQN", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const fqn = await installMcp(c, "github/cli");
      expect(fqn).toBe("github/cli");
      expect(c.listMcps()).toContain("github/cli");
    });

    it("installs an MCP with reverse-DNS namespace", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const fqn = await installMcp(c, "io.github.user/weather");
      expect(fqn).toBe("io.github.user/weather");
    });
  });

  describe("resolveAgent / resolveSkill", () => {
    it("resolveAgent: returns agent + transitive deps", async () => {
      const c = await CatalogManager.open({ catalogDir });
      await installMcp(c, "github/cli");
      const skillSrc = await makeSkill("security-audit");
      await c.installSkill(skillSrc);
      const agentSrc = await makeAgent("reviewer", {
        deps: { skills: [dep("security-audit")], mcps: [mcpDep("github/cli")] },
      });
      await c.installAgent(agentSrc);

      const result = c.resolveAgent("public/reviewer");
      expect(result.agent.name).toBe("public/reviewer");
      expect(result.skills.map((s) => s.skill.name)).toContain("public/security-audit");
      expect(result.mcps.map((m) => m.name)).toContain("github/cli");
    });

    it("resolveAgent: transitive skill dependencies in topological order", async () => {
      const c = await CatalogManager.open({ catalogDir });
      await installMcp(c, "semgrep/cli");
      const leafSrc = await makeSkill("cve-db");
      await c.installSkill(leafSrc);
      const midSrc = await makeSkill("security-audit", {
        deps: { skills: [dep("cve-db")], mcps: [mcpDep("semgrep/cli")] },
      });
      await c.installSkill(midSrc);
      const agentSrc = await makeAgent("reviewer", {
        deps: { skills: [dep("security-audit")] },
      });
      await c.installAgent(agentSrc);

      const result = c.resolveAgent("public/reviewer");
      const names = result.skills.map((s) => s.skill.name);
      expect(names).toContain("public/cve-db");
      expect(names).toContain("public/security-audit");
      expect(names.indexOf("public/cve-db")).toBeLessThan(names.indexOf("public/security-audit"));
      expect(result.mcps.map((m) => m.name)).toContain("semgrep/cli");
    });

    it("resolveSkill: includes the entry skill itself in skills[]", async () => {
      const c = await CatalogManager.open({ catalogDir });
      await installMcp(c, "semgrep/cli");
      const leafSrc = await makeSkill("cve-db");
      await c.installSkill(leafSrc);
      const midSrc = await makeSkill("security-audit", {
        deps: { skills: [dep("cve-db")], mcps: [mcpDep("semgrep/cli")] },
      });
      await c.installSkill(midSrc);

      const result = c.resolveSkill("public/security-audit");
      expect(result.skill.name).toBe("public/security-audit");
      const names = result.skills.map((s) => s.skill.name);
      expect(names).toEqual(["public/cve-db", "public/security-audit"]);
      expect(result.mcps.map((m) => m.name)).toContain("semgrep/cli");
    });

    it("throws for unknown name", async () => {
      const c = await CatalogManager.open({ catalogDir });
      expect(() => c.resolveAgent("public/nope")).toThrow("agent not found in catalog");
      expect(() => c.resolveSkill("public/nope")).toThrow("skill not found in catalog");
    });
  });

  describe("inspectSource", () => {
    it("inspects a skill source", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeSkill("weather", { description: "Weather skill" });
      const result = await c.inspectSource(src);
      expect(result.name).toBe("public/weather");
      expect(result.description).toBe("Weather skill");
    });

    it("inspects an agent source", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeAgent("reviewer", { description: "PR reviewer" });
      const result = await c.inspectSource(src);
      expect(result.name).toBe("public/reviewer");
      expect(result.description).toBe("PR reviewer");
    });
  });

  describe("name validation", () => {
    it("accepts unscoped kebab-case (becomes public/<name>)", async () => {
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
    await installMcp(c, "github/cli");
    const skillSrc = await makeSkill("lint", { deps: { mcps: [mcpDep("github/cli")] } });
    await c.installSkill(skillSrc);

    const entry = c.getSkillEntry("public/lint");
    expect(entry!.status).toBe("ready");
    expect(entry!.missingDeps).toBeUndefined();
  });

  it("skill is disabled when dep missing", async () => {
    const c = await CatalogManager.open({ catalogDir });
    const skillSrc = await makeSkill("lint", { deps: { mcps: [mcpDep("github/cli")] } });
    await c.installSkill(skillSrc);

    const entry = c.getSkillEntry("public/lint");
    expect(entry!.status).toBe("disabled");
    expect(entry!.missingDeps?.map((d) => d.name)).toContain("github/cli");
    expect(entry!.missingDeps?.find((d) => d.name === "github/cli")?.kind).toBe("mcp");
  });

  it("skill becomes ready after dep installed", async () => {
    const c = await CatalogManager.open({ catalogDir });
    const skillSrc = await makeSkill("lint", { deps: { mcps: [mcpDep("github/cli")] } });
    await c.installSkill(skillSrc);
    expect(c.getSkillEntry("public/lint")!.status).toBe("disabled");

    await installMcp(c, "github/cli");
    expect(c.getSkillEntry("public/lint")!.status).toBe("ready");
  });

  it("skill becomes disabled after dep removed", async () => {
    const c = await CatalogManager.open({ catalogDir });
    await installMcp(c, "github/cli");
    const skillSrc = await makeSkill("lint", { deps: { mcps: [mcpDep("github/cli")] } });
    await c.installSkill(skillSrc);
    expect(c.getSkillEntry("public/lint")!.status).toBe("ready");

    // Remove dep — but lint depends on it, so should be blocked
    await expect(c.removeMcp("github/cli")).rejects.toThrow();
  });

  it("agent is disabled when skill dep missing", async () => {
    const c = await CatalogManager.open({ catalogDir });
    const agentSrc = await makeAgent("reviewer", { deps: { skills: [dep("lint")] } });
    await c.installAgent(agentSrc);

    const entry = c.getAgentEntry("public/reviewer");
    expect(entry!.status).toBe("disabled");
    expect(entry!.missingDeps?.map((d) => d.name)).toContain("public/lint");
    expect(entry!.missingDeps?.find((d) => d.name === "public/lint")?.kind).toBe("skill");
  });

  it("agent becomes ready after skill installed", async () => {
    const c = await CatalogManager.open({ catalogDir });
    const agentSrc = await makeAgent("reviewer", { deps: { skills: [dep("lint")] } });
    await c.installAgent(agentSrc);
    expect(c.getAgentEntry("public/reviewer")!.status).toBe("disabled");

    const skillSrc = await makeSkill("lint");
    await c.installSkill(skillSrc);
    expect(c.getAgentEntry("public/reviewer")!.status).toBe("ready");
  });

  it("listSkillEntries returns all with status", async () => {
    const c = await CatalogManager.open({ catalogDir });
    await c.installSkill(await makeSkill("a"));
    await c.installSkill(await makeSkill("b", { deps: { skills: [dep("missing")] } }));

    const entries = c.listSkillEntries();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.skill.name === "public/a")!.status).toBe("ready");
    expect(entries.find((e) => e.skill.name === "public/b")!.status).toBe("disabled");
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
    await c.installSkill(await makeSkill("lint", { deps: { mcps: [mcpDep("github/cli")] } }));
    expect(c.getSkillEntry("public/lint")!.status).toBe("disabled");

    // Manually write MCP file to disk under the github/ namespace
    // (two-level layout) with the inline `_meta` block then rescan.
    const mcpDir = join(catalogDir, "mcps", "github");
    await mkdir(mcpDir, { recursive: true });
    await writeFile(
      join(mcpDir, "cli.json"),
      JSON.stringify({
        command: "gh",
        _meta: { name: "github/cli", origin: "file:/seeded/github/cli.json" },
      }),
    );
    await c.rescan();
    expect(c.getSkillEntry("public/lint")!.status).toBe("ready");
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
