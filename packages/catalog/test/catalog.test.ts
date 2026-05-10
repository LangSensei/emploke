import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HasDependents, NameInvalid, NotFound } from "../src/errors.js";
import { CatalogManager } from "../src/manager.js";
import {
  dep,
  installCatalogAgentFromDir,
  installCatalogSkillFromDir,
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

    it("scans existing skills under their path-derived scope", async () => {
      // Path-as-truth: the directory layout defines FQN, not the
      // frontmatter. An entry at skills/public/weather/ has FQN
      // public/weather; one at skills/langsensei/analytics/ has
      // FQN langsensei/analytics — even when frontmatter omits scope:.
      const skillDir = join(catalogDir, "skills", "public", "weather");
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
      const agentDir = join(catalogDir, "agents", "public", "reviewer");
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
      const skill = await installCatalogSkillFromDir(c, src);
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
      const skill = await installCatalogSkillFromDir(c, src);
      expect(skill.name).toBe("langsensei/weather");
      const onDisk = join(catalogDir, "skills", "langsensei", "weather", "SKILL.md");
      expect(await readFile(onDisk, "utf8")).toContain("langsensei");
    });

    it("updates (upserts) existing skill", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src1 = await makeSkill("weather", { version: "1.0.0" });
      await installCatalogSkillFromDir(c, src1);
      const src2 = await makeSkill("weather", { version: "2.0.0" });
      const updated = await installCatalogSkillFromDir(c, src2);
      expect(updated.version).toBe("2.0.0");
      expect(c.listSkills()).toHaveLength(1);
    });

    it("reinstall leaves zero leftover dirs in scope folder", async () => {
      // Regression for the zombie-skill bug chain:
      //   bug 2: installStreamToDir wrote `<dest>.<pid>.<ts>.tmp` into scan path
      //   bug 3: replaceDirAtomic wrote `.<basename>.tmp.<stamp>` /
      //          `.<basename>.old.<stamp>` into dst.parent (= scan path)
      // After the fix, the scope dir (skills/<scope>/) must contain ONLY
      // entry dirs, even after many install + reinstall cycles. Anything
      // else would get scanned as a real entry, causing zombies after delete.
      const c = await CatalogManager.open({ catalogDir });
      const scopeDir = join(catalogDir, "skills", "public");
      for (let i = 0; i < 5; i++) {
        const src = await makeSkill("weather", { version: `${i + 1}.0.0` });
        await installCatalogSkillFromDir(c, src);
      }
      const entries = await readdir(scopeDir);
      expect(entries.sort()).toEqual(["weather"]);
      // After install + delete + reinstall, scope dir is still clean
      await c.removeSkill("public/weather");
      const src = await makeSkill("weather", { version: "9.0.0" });
      await installCatalogSkillFromDir(c, src);
      expect((await readdir(scopeDir)).sort()).toEqual(["weather"]);
    });

    it("preserves prereqs", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeSkill("setup", { prereqs: "Run setup.sh first" });
      const skill = await installCatalogSkillFromDir(c, src);
      expect(skill.prereqs).toBe("Run setup.sh first");
    });

    it("rejects invalid name", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const dir = join(sourceDir, "bad");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: Bad_Name\ndescription: x\n---\n");
      await expect(installCatalogSkillFromDir(c, dir)).rejects.toThrow(NameInvalid);
    });
  });

  describe("removeSkill", () => {
    it("removes an installed skill", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeSkill("weather");
      await installCatalogSkillFromDir(c, src);
      await c.removeSkill("public/weather");
      expect(c.getSkill("public/weather")).toBeNull();
    });

    it("removed skill stays gone after rescan (no zombie revival from path/frontmatter mismatch)", async () => {
      // Regression: install + delete + rescan must NOT bring the entry
      // back. Previously, scan re-derived FQN from frontmatter (which
      // could disagree with the path) so delete-by-FQN computed the
      // wrong path and left orphan files that scan resurrected.
      const c = await CatalogManager.open({ catalogDir });
      await installCatalogSkillFromDir(c, await makeSkill("ghost"));
      await c.removeSkill("public/ghost");
      await c.rescan();
      expect(c.getSkill("public/ghost")).toBeNull();
      expect(c.listSkills().map((s) => s.name)).not.toContain("public/ghost");
    });

    it("crash-leftover .tmp dir is wiped at boot and never appears in scan", async () => {
      // Regression: previously installStreamToDir wrote to <dest>.<pid>.<ts>.tmp
      // INSIDE the scan path. A killed install left the partial tree there;
      // the next scan picked up the partial SKILL.md (if any) as a real
      // entry. Now the tmp lives in <catalogDir>/.tmp/ and is wiped at
      // CatalogManager.open().
      // Simulate a crashed install: write a partial entry directly into
      // <catalogDir>/.tmp/ before opening the catalog.
      const tmpDir = join(catalogDir, ".tmp", "leftover-from-crash");
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        join(tmpDir, "SKILL.md"),
        "---\nname: leftover\ndescription: should never appear\n---\n",
      );
      const c = await CatalogManager.open({ catalogDir });
      // .tmp should be wiped on open
      const stillThere = await readFile(join(tmpDir, "SKILL.md"), "utf8").catch(() => null);
      expect(stillThere).toBeNull();
      // And it certainly should not be in the catalog
      expect(c.listSkills().map((s) => s.name)).not.toContain("public/leftover");
    });

    it("throws NotFound for unknown skill", async () => {
      const c = await CatalogManager.open({ catalogDir });
      await expect(c.removeSkill("public/nope")).rejects.toThrow(NotFound);
    });

    it("blocks removal if another skill depends on it", async () => {
      const c = await CatalogManager.open({ catalogDir });
      await installMcp(c, "github/cli");
      const leafSrc = await makeSkill("leaf", { description: "Leaf" });
      await installCatalogSkillFromDir(c, leafSrc);
      const parentSrc = await makeSkill("parent", { deps: { skills: [dep("leaf")] } });
      await installCatalogSkillFromDir(c, parentSrc);
      await expect(c.removeSkill("public/leaf")).rejects.toThrow(HasDependents);
    });
  });

  describe("installAgent", () => {
    it("installs an agent", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeAgent("reviewer", { description: "Reviews PRs" });
      const agent = await installCatalogAgentFromDir(c, src);
      expect(agent.name).toBe("public/reviewer");
      expect(c.getAgent("public/reviewer")).toEqual(agent);
    });

    it("installs a scoped agent via frontmatter scope:", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeAgent("reviewer", { scope: "langsensei" });
      const agent = await installCatalogAgentFromDir(c, src);
      expect(agent.name).toBe("langsensei/reviewer");
    });
  });

  describe("removeAgent", () => {
    it("removes an installed agent", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeAgent("reviewer");
      await installCatalogAgentFromDir(c, src);
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
      await installCatalogSkillFromDir(c, skillSrc);
      const agentSrc = await makeAgent("reviewer", {
        deps: { skills: [dep("security-audit")], mcps: [mcpDep("github/cli")] },
      });
      await installCatalogAgentFromDir(c, agentSrc);

      const result = c.resolveAgent("public/reviewer");
      expect(result.agent.name).toBe("public/reviewer");
      expect(result.skills.map((s) => s.skill.name)).toContain("public/security-audit");
      expect(result.mcps.map((m) => m.name)).toContain("github/cli");
    });

    it("resolveAgent: transitive skill dependencies in topological order", async () => {
      const c = await CatalogManager.open({ catalogDir });
      await installMcp(c, "semgrep/cli");
      const leafSrc = await makeSkill("cve-db");
      await installCatalogSkillFromDir(c, leafSrc);
      const midSrc = await makeSkill("security-audit", {
        deps: { skills: [dep("cve-db")], mcps: [mcpDep("semgrep/cli")] },
      });
      await installCatalogSkillFromDir(c, midSrc);
      const agentSrc = await makeAgent("reviewer", {
        deps: { skills: [dep("security-audit")] },
      });
      await installCatalogAgentFromDir(c, agentSrc);

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
      await installCatalogSkillFromDir(c, leafSrc);
      const midSrc = await makeSkill("security-audit", {
        deps: { skills: [dep("cve-db")], mcps: [mcpDep("semgrep/cli")] },
      });
      await installCatalogSkillFromDir(c, midSrc);

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

  describe("name validation", () => {
    it("accepts unscoped kebab-case (becomes public/<name>)", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeSkill("my-skill");
      await expect(installCatalogSkillFromDir(c, src)).resolves.toBeDefined();
    });

    it("accepts explicit scope via frontmatter", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const src = await makeSkill("my-skill", { scope: "langsensei" });
      await expect(installCatalogSkillFromDir(c, src)).resolves.toBeDefined();
    });

    it("rejects uppercase short name", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const dir = join(sourceDir, "bad");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: Bad\ndescription: x\n---\n");
      await expect(installCatalogSkillFromDir(c, dir)).rejects.toThrow(NameInvalid);
    });

    it("rejects slashes in the short-name field", async () => {
      const c = await CatalogManager.open({ catalogDir });
      const dir = join(sourceDir, "bad2");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: a/b\ndescription: x\n---\n");
      await expect(installCatalogSkillFromDir(c, dir)).rejects.toThrow();
    });
  });
});

describe("entry status", () => {
  it("skill is ready when all deps present", async () => {
    const c = await CatalogManager.open({ catalogDir });
    await installMcp(c, "github/cli");
    const skillSrc = await makeSkill("lint", { deps: { mcps: [mcpDep("github/cli")] } });
    await installCatalogSkillFromDir(c, skillSrc);

    const entry = c.getSkillEntry("public/lint");
    expect(entry!.status).toBe("ready");
    expect(entry!.missingDeps).toBeUndefined();
  });

  it("skill is disabled when dep missing", async () => {
    const c = await CatalogManager.open({ catalogDir });
    const skillSrc = await makeSkill("lint", { deps: { mcps: [mcpDep("github/cli")] } });
    await installCatalogSkillFromDir(c, skillSrc);

    const entry = c.getSkillEntry("public/lint");
    expect(entry!.status).toBe("disabled");
    expect(entry!.missingDeps?.map((d) => d.name)).toContain("github/cli");
    expect(entry!.missingDeps?.find((d) => d.name === "github/cli")?.kind).toBe("mcp");
  });

  it("skill becomes ready after dep installed", async () => {
    const c = await CatalogManager.open({ catalogDir });
    const skillSrc = await makeSkill("lint", { deps: { mcps: [mcpDep("github/cli")] } });
    await installCatalogSkillFromDir(c, skillSrc);
    expect(c.getSkillEntry("public/lint")!.status).toBe("disabled");

    await installMcp(c, "github/cli");
    expect(c.getSkillEntry("public/lint")!.status).toBe("ready");
  });

  it("skill becomes disabled after dep removed", async () => {
    const c = await CatalogManager.open({ catalogDir });
    await installMcp(c, "github/cli");
    const skillSrc = await makeSkill("lint", { deps: { mcps: [mcpDep("github/cli")] } });
    await installCatalogSkillFromDir(c, skillSrc);
    expect(c.getSkillEntry("public/lint")!.status).toBe("ready");

    // Remove dep — but lint depends on it, so should be blocked
    await expect(c.removeMcp("github/cli")).rejects.toThrow();
  });

  it("agent is disabled when skill dep missing", async () => {
    const c = await CatalogManager.open({ catalogDir });
    const agentSrc = await makeAgent("reviewer", { deps: { skills: [dep("lint")] } });
    await installCatalogAgentFromDir(c, agentSrc);

    const entry = c.getAgentEntry("public/reviewer");
    expect(entry!.status).toBe("disabled");
    expect(entry!.missingDeps?.map((d) => d.name)).toContain("public/lint");
    expect(entry!.missingDeps?.find((d) => d.name === "public/lint")?.kind).toBe("skill");
  });

  it("agent becomes ready after skill installed", async () => {
    const c = await CatalogManager.open({ catalogDir });
    const agentSrc = await makeAgent("reviewer", { deps: { skills: [dep("lint")] } });
    await installCatalogAgentFromDir(c, agentSrc);
    expect(c.getAgentEntry("public/reviewer")!.status).toBe("disabled");

    const skillSrc = await makeSkill("lint");
    await installCatalogSkillFromDir(c, skillSrc);
    expect(c.getAgentEntry("public/reviewer")!.status).toBe("ready");
  });

  it("listSkillEntries returns all with status", async () => {
    const c = await CatalogManager.open({ catalogDir });
    await installCatalogSkillFromDir(c, await makeSkill("a"));
    await installCatalogSkillFromDir(
      c,
      await makeSkill("b", { deps: { skills: [dep("missing")] } }),
    );

    const entries = c.listSkillEntries();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.skill.name === "public/a")!.status).toBe("ready");
    expect(entries.find((e) => e.skill.name === "public/b")!.status).toBe("disabled");
  });

  it("listAgentEntries returns all with status", async () => {
    const c = await CatalogManager.open({ catalogDir });
    await installCatalogAgentFromDir(c, await makeAgent("simple"));
    const entries = c.listAgentEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("ready");
  });

  it("rescan recomputes status", async () => {
    const c = await CatalogManager.open({ catalogDir });
    await installCatalogSkillFromDir(
      c,
      await makeSkill("lint", { deps: { mcps: [mcpDep("github/cli")] } }),
    );
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
