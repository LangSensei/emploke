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
import {
  dep,
  makeAgentSource,
  makeBase,
  makeMcpSource,
  makeSkillSource,
  mcpDep,
} from "./helpers.js";

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

async function installMcp(specName: string): Promise<void> {
  const file = await makeMcpSource(sourceDir, specName.replace("/", "_"));
  await mcps.install(file, { name: specName, origin: `file:${file}` });
}

describe("Resolver", () => {
  it("resolveAgent: agent with direct deps", async () => {
    await installMcp("github/cli");
    await skills.install(await makeSkillSource(sourceDir, "lint"));
    await agents.install(
      await makeAgentSource(sourceDir, "reviewer", {
        deps: { skills: [dep("lint")], mcps: [mcpDep("github/cli")] },
      }),
    );

    const result = resolver.resolveAgent("public/reviewer");
    expect(result.agent.name).toBe("public/reviewer");
    expect(result.skills.map((s) => s.skill.name)).toEqual(["public/lint"]);
    expect(result.mcps.map((m) => m.name)).toEqual(["github/cli"]);
  });

  it("resolveSkill: skill with direct deps; entry skill is included in skills[]", async () => {
    await installMcp("semgrep/cli");
    await skills.install(await makeSkillSource(sourceDir, "cve-db"));
    await skills.install(
      await makeSkillSource(sourceDir, "security-audit", {
        deps: { skills: [dep("cve-db")], mcps: [mcpDep("semgrep/cli")] },
      }),
    );

    const result = resolver.resolveSkill("public/security-audit");
    expect(result.skill.name).toBe("public/security-audit");
    const names = result.skills.map((s) => s.skill.name);
    expect(names).toContain("public/cve-db");
    expect(names).toContain("public/security-audit");
    expect(names.indexOf("public/cve-db")).toBeLessThan(names.indexOf("public/security-audit"));
    expect(result.mcps.map((m) => m.name)).toContain("semgrep/cli");
  });

  it("resolveAgent: transitive dependencies in topological order", async () => {
    await installMcp("postgres/db");
    await skills.install(await makeSkillSource(sourceDir, "leaf"));
    await skills.install(
      await makeSkillSource(sourceDir, "mid", {
        deps: { skills: [dep("leaf")], mcps: [mcpDep("postgres/db")] },
      }),
    );
    await agents.install(
      await makeAgentSource(sourceDir, "top", { deps: { skills: [dep("mid")] } }),
    );

    const result = resolver.resolveAgent("public/top");
    const names = result.skills.map((s) => s.skill.name);
    expect(names).toContain("public/leaf");
    expect(names).toContain("public/mid");
    expect(names.indexOf("public/leaf")).toBeLessThan(names.indexOf("public/mid"));
    expect(result.mcps.map((m) => m.name)).toContain("postgres/db");
  });

  it("resolveAgent: throws for unknown name", () => {
    expect(() => resolver.resolveAgent("public/nope")).toThrow("agent not found in catalog");
  });

  it("resolveSkill: throws for unknown name", () => {
    expect(() => resolver.resolveSkill("public/nope")).toThrow("skill not found in catalog");
  });

  it("resolveAgent: throws helpful error when name is a skill", async () => {
    await skills.install(await makeSkillSource(sourceDir, "a-skill"));
    expect(() => resolver.resolveAgent("public/a-skill")).toThrow(
      "is a skill, not an agent — use resolveSkill() instead",
    );
  });

  it("resolveSkill: throws helpful error when name is an agent", async () => {
    await agents.install(await makeAgentSource(sourceDir, "an-agent"));
    expect(() => resolver.resolveSkill("public/an-agent")).toThrow(
      "is an agent, not a skill — use resolveAgent() instead",
    );
  });

  it("resolveAgent: agent with no deps", async () => {
    await agents.install(await makeAgentSource(sourceDir, "simple"));
    const result = resolver.resolveAgent("public/simple");
    expect(result.skills).toHaveLength(0);
    expect(result.mcps).toHaveLength(0);
    expect(result.agent.name).toBe("public/simple");
  });

  it("resolveSkill: skill with no deps still returns itself", async () => {
    await skills.install(await makeSkillSource(sourceDir, "standalone"));
    const result = resolver.resolveSkill("public/standalone");
    expect(result.skills.map((s) => s.skill.name)).toEqual(["public/standalone"]);
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

    expect(() => resolver.resolveAgent("public/outer-agent")).toThrow(
      "is an agent and cannot be a dependency",
    );
    expect(() => resolver.resolveSkill("public/bad-skill")).toThrow(
      "is an agent and cannot be a dependency",
    );
  });
});
