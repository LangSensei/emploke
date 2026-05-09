import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCatalog } from "../src/agent/agent-catalog.js";
import { McpCatalog } from "../src/mcp/mcp-catalog.js";
import { FsAgentRepository } from "../src/repositories/fs-agent-repository.js";
import { FsMcpRepository } from "../src/repositories/fs-mcp-repository.js";
import { FsSkillRepository } from "../src/repositories/fs-skill-repository.js";
import { Resolver } from "../src/resolver.js";
import { SkillCatalog } from "../src/skill/skill-catalog.js";
import { dep, makeAgentSource, makeBase, makeMcpSource, makeSkillSource } from "./helpers.js";

let catalogDir: string;
let sourceDir: string;
let skills: SkillCatalog;
let agents: AgentCatalog;
let mcps: McpCatalog;
let resolver: Resolver;

beforeEach(async () => {
  const base = makeBase("resolver");
  catalogDir = join(base, "catalog");
  sourceDir = join(base, "source");
  await mkdir(catalogDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  skills = new SkillCatalog(new FsSkillRepository(catalogDir));
  agents = new AgentCatalog(new FsAgentRepository(catalogDir));
  mcps = new McpCatalog(new FsMcpRepository(catalogDir));
  resolver = new Resolver(skills, agents, mcps);
});

afterEach(async () => {
  await rm(join(catalogDir, ".."), { recursive: true, force: true });
});

describe("Resolver", () => {
  it("resolveAgent: agent with direct deps", async () => {
    await mcps.install(await makeMcpSource(sourceDir, "github"));
    await skills.install(await makeSkillSource(sourceDir, "lint"));
    await agents.install(
      await makeAgentSource(sourceDir, "reviewer", {
        deps: { skills: [dep("lint")], mcps: [dep("github")] },
      }),
    );

    const result = resolver.resolveAgent("local/reviewer");
    expect(result.agent.name).toBe("local/reviewer");
    expect(result.skills.map((s) => s.skill.name)).toEqual(["local/lint"]);
    expect(result.mcps.map((m) => m.name)).toEqual(["local/github"]);
  });

  it("resolveSkill: skill with direct deps; entry skill is included in skills[]", async () => {
    await mcps.install(await makeMcpSource(sourceDir, "semgrep"));
    await skills.install(await makeSkillSource(sourceDir, "cve-db"));
    await skills.install(
      await makeSkillSource(sourceDir, "security-audit", {
        deps: { skills: [dep("cve-db")], mcps: [dep("semgrep")] },
      }),
    );

    const result = resolver.resolveSkill("local/security-audit");
    expect(result.skill.name).toBe("local/security-audit");
    const names = result.skills.map((s) => s.skill.name);
    expect(names).toContain("local/cve-db");
    expect(names).toContain("local/security-audit");
    expect(names.indexOf("local/cve-db")).toBeLessThan(names.indexOf("local/security-audit"));
    expect(result.mcps.map((m) => m.name)).toContain("local/semgrep");
  });

  it("resolveAgent: transitive dependencies in topological order", async () => {
    await mcps.install(await makeMcpSource(sourceDir, "db"));
    await skills.install(await makeSkillSource(sourceDir, "leaf"));
    await skills.install(
      await makeSkillSource(sourceDir, "mid", {
        deps: { skills: [dep("leaf")], mcps: [dep("db")] },
      }),
    );
    await agents.install(
      await makeAgentSource(sourceDir, "top", { deps: { skills: [dep("mid")] } }),
    );

    const result = resolver.resolveAgent("local/top");
    const names = result.skills.map((s) => s.skill.name);
    expect(names).toContain("local/leaf");
    expect(names).toContain("local/mid");
    expect(names.indexOf("local/leaf")).toBeLessThan(names.indexOf("local/mid"));
    expect(result.mcps.map((m) => m.name)).toContain("local/db");
  });

  it("resolveAgent: throws for unknown name", () => {
    expect(() => resolver.resolveAgent("local/nope")).toThrow("agent not found in catalog");
  });

  it("resolveSkill: throws for unknown name", () => {
    expect(() => resolver.resolveSkill("local/nope")).toThrow("skill not found in catalog");
  });

  it("resolveAgent: throws helpful error when name is a skill", async () => {
    await skills.install(await makeSkillSource(sourceDir, "a-skill"));
    expect(() => resolver.resolveAgent("local/a-skill")).toThrow(
      "is a skill, not an agent — use resolveSkill() instead",
    );
  });

  it("resolveSkill: throws helpful error when name is an agent", async () => {
    await agents.install(await makeAgentSource(sourceDir, "an-agent"));
    expect(() => resolver.resolveSkill("local/an-agent")).toThrow(
      "is an agent, not a skill — use resolveAgent() instead",
    );
  });

  it("resolveAgent: agent with no deps", async () => {
    await agents.install(await makeAgentSource(sourceDir, "simple"));
    const result = resolver.resolveAgent("local/simple");
    expect(result.skills).toHaveLength(0);
    expect(result.mcps).toHaveLength(0);
    expect(result.agent.name).toBe("local/simple");
  });

  it("resolveSkill: skill with no deps still returns itself", async () => {
    await skills.install(await makeSkillSource(sourceDir, "standalone"));
    const result = resolver.resolveSkill("local/standalone");
    expect(result.skills.map((s) => s.skill.name)).toEqual(["local/standalone"]);
    expect(result.mcps).toHaveLength(0);
  });

  it("rejects an agent listed as a dependency (agents can only depend on others, not be depended on)", async () => {
    await agents.install(await makeAgentSource(sourceDir, "inner-agent"));
    await skills.install(
      await makeSkillSource(sourceDir, "bad-skill", { deps: { skills: [dep("inner-agent")] } }),
    );
    await agents.install(
      await makeAgentSource(sourceDir, "outer-agent", { deps: { skills: [dep("bad-skill")] } }),
    );

    expect(() => resolver.resolveAgent("local/outer-agent")).toThrow(
      "is an agent and cannot be a dependency",
    );
    expect(() => resolver.resolveSkill("local/bad-skill")).toThrow(
      "is an agent and cannot be a dependency",
    );
  });
});
