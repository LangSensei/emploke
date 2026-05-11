import type { EntryFile } from "@emploke/catalog-fetcher";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFetcher, AgentService } from "../../src/agent/agent-service.js";
import { SqliteAgentRepository } from "../../src/agent/sqlite-agent-repository.js";
import {
  type CatalogConflict,
  CatalogManager,
  type McpResolveAdapter,
  type McpResolvedNode,
} from "../../src/facade/catalog-manager.js";
import * as McpFormat from "../../src/mcp/mcp-format.js";
import { McpService } from "../../src/mcp/mcp-service.js";
import { SqliteMcpRepository } from "../../src/mcp/sqlite-mcp-repository.js";
import { type SkillFetcher, SkillService } from "../../src/skill/skill-service.js";
import { SqliteSkillRepository } from "../../src/skill/sqlite-skill-repository.js";

/**
 * Tests for the sync flow: identity check, version short-circuit, dep
 * diff (orphan detection), and orphan auto-clear on subsequent install.
 *
 * Uses the same fake-fetcher pattern as `catalog-manager.test.ts` but
 * spelled out locally so each test can mutate fixture content in-flight
 * (sync's whole point is "what changed upstream") without polluting
 * the broader test fixture.
 */

interface Fakes {
  skillFetcher: SkillFetcher;
  agentFetcher: AgentFetcher;
  mcpResolveAdapter: McpResolveAdapter;
  mcpFetchTree: (origin: string) => AsyncIterable<EntryFile>;
  setSkill: (origin: string, files: Record<string, string>) => void;
  setAgent: (origin: string, files: Record<string, string>) => void;
  setMcp: (origin: string, name: string, content: string) => void;
}

function makeFakes(): Fakes {
  const trees = new Map<string, Map<string, Buffer>>();
  const mcpStore = new Map<string, { origin: string; content: string }>();

  const tree = (o: string): Map<string, Buffer> => {
    const t = trees.get(o);
    if (t === undefined) throw new Error(`no fixture for ${o}`);
    return t;
  };
  const skillFetcher: SkillFetcher = {
    async fetchAnchor(origin) {
      const a = tree(origin).get("SKILL.md");
      if (a === undefined) throw new Error(`no SKILL.md at ${origin}`);
      return a.toString("utf8");
    },
    async *fetchTree(origin) {
      for (const [relPath, content] of tree(origin)) yield { relPath, content };
    },
  };
  const agentFetcher: AgentFetcher = {
    async fetchAnchor(origin) {
      const a = tree(origin).get("AGENTS.md");
      if (a === undefined) throw new Error(`no AGENTS.md at ${origin}`);
      return a.toString("utf8");
    },
    async *fetchTree(origin) {
      for (const [relPath, content] of tree(origin)) yield { relPath, content };
    },
  };
  const mcpFetchTree = async function* (o: string): AsyncIterable<EntryFile> {
    const s = mcpStore.get(o);
    if (s === undefined) throw new Error(`no MCP at ${o}`);
    yield { relPath: "mcp.json", content: Buffer.from(s.content, "utf8") };
  };
  const mcpResolveAdapter: McpResolveAdapter = async (origin) => {
    const s = mcpStore.get(origin);
    if (s === undefined) {
      const conflict: CatalogConflict = {
        kind: "mcp",
        origin,
        fqn: null,
        reason: { kind: "fetch-failed", cause: new Error(`no MCP at ${origin}`) },
      };
      return { node: null, conflict };
    }
    const parsed = McpFormat.parse(s.content, `resolve:${origin}`);
    const merged = McpFormat.writeMeta(
      s.content,
      { name: parsed.meta.name, origin },
      `resolve:${origin}`,
    );
    const node: McpResolvedNode = { fqn: parsed.meta.name, origin, content: merged };
    return { node, conflict: null };
  };
  return {
    skillFetcher,
    agentFetcher,
    mcpResolveAdapter,
    mcpFetchTree,
    setSkill(o, files) {
      const m = new Map<string, Buffer>();
      for (const [k, v] of Object.entries(files)) m.set(k, Buffer.from(v, "utf8"));
      trees.set(o, m);
    },
    setAgent(o, files) {
      const m = new Map<string, Buffer>();
      for (const [k, v] of Object.entries(files)) m.set(k, Buffer.from(v, "utf8"));
      trees.set(o, m);
    },
    setMcp(o, name, content) {
      const merged = McpFormat.writeMeta(content, { name, origin: o }, `seed:${o}`);
      mcpStore.set(o, { origin: o, content: merged });
      const m = new Map<string, Buffer>();
      m.set("mcp.json", Buffer.from(merged, "utf8"));
      trees.set(o, m);
    },
  };
}

const SKILL_ANCHOR = (name: string, version = "1.0.0", extra = "") => `---
name: ${name}
description: x
version: ${version}
${extra}
---
# Body
`;

const AGENT_ANCHOR = (name: string, version = "1.0.0", extra = "") => `---
name: ${name}
description: x
version: ${version}
${extra}
---
# Body
`;

const MCP_BODY = `{ "command": "node", "args": ["server.js"] }`;

let mcpRepo: SqliteMcpRepository;
let skillRepo: SqliteSkillRepository;
let agentRepo: SqliteAgentRepository;
let fakes: Fakes;
let mgr: CatalogManager;

beforeEach(() => {
  mcpRepo = new SqliteMcpRepository(":memory:");
  skillRepo = new SqliteSkillRepository(":memory:");
  agentRepo = new SqliteAgentRepository(":memory:");
  fakes = makeFakes();
  const mcpSvc = new McpService(mcpRepo, fakes.mcpFetchTree);
  const skillSvc = new SkillService(skillRepo, fakes.skillFetcher);
  const agentSvc = new AgentService(agentRepo, fakes.agentFetcher);
  mgr = new CatalogManager(mcpSvc, skillSvc, agentSvc, fakes.mcpResolveAdapter);
});

afterEach(() => {
  mcpRepo.close();
  skillRepo.close();
  agentRepo.close();
});

describe("sync resolve — identity check", () => {
  it("up-to-date when fqn + version + deps unchanged", async () => {
    fakes.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool") });
    await mgr.installSkill("file:/abs/tool");

    const plan = await mgr.resolveSyncSkill("public/tool");
    expect(plan.isSync).toBe(true);
    expect(plan.upToDate).toBe(true);
    expect(plan.toInstall).toHaveLength(0);
    expect(plan.identityChange).toBeUndefined();
  });

  it("identity-changed when upstream renames under the same URL", async () => {
    fakes.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool") });
    await mgr.installSkill("file:/abs/tool");

    // Upstream rename: same origin, different name
    fakes.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("toolbox") });
    const plan = await mgr.resolveSyncSkill("public/tool");
    expect(plan.identityChange).toEqual({
      kind: "skill",
      oldFqn: "public/tool",
      newFqn: "public/toolbox",
    });
    // Identity-changed bails before walking deps
    expect(plan.toInstall).toHaveLength(1);
    expect(plan.toInstall[0]?.disposition).toBe("identity-changed");
  });

  it("applySync on identity-changed deletes old fqn row + installs new", async () => {
    fakes.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool") });
    await mgr.installSkill("file:/abs/tool");

    fakes.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("toolbox") });
    const plan = await mgr.resolveSyncSkill("public/tool");
    await mgr.applySync(plan);

    expect(await mgr.getSkill("public/tool")).toBeNull();
    const renamed = await mgr.getSkill("public/toolbox");
    expect(renamed).not.toBeNull();
    expect(renamed?.origin).toBe("file:/abs/tool");
  });
});

describe("sync resolve — version short-circuit", () => {
  it("will-sync when version bumped", async () => {
    fakes.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool", "1.0.0") });
    await mgr.installSkill("file:/abs/tool");

    fakes.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool", "1.1.0") });
    const plan = await mgr.resolveSyncSkill("public/tool");
    expect(plan.upToDate).toBe(false);
    expect(plan.toInstall.find((n) => n.node.fqn === "public/tool")?.disposition).toBe("will-sync");
  });
});

describe("sync resolve — orphan detection", () => {
  it("dropped dep with zero remaining reverse-deps becomes an orphan", async () => {
    fakes.setMcp("file:/abs/mcp/x", "vendor/x", MCP_BODY);
    fakes.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", "1.0.0", `dependencies:\n  mcps:\n    - "file:/abs/mcp/x"`),
    });
    await mgr.installSkill("file:/abs/tool");
    expect(await mgr.getMcp("vendor/x")).not.toBeNull();

    // Upstream drops the mcp dep and bumps the version
    fakes.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool", "1.1.0") });
    const plan = await mgr.resolveSyncSkill("public/tool");
    expect(plan.orphans).toHaveLength(1);
    expect(plan.orphans[0]).toMatchObject({ kind: "mcp", fqn: "vendor/x" });
  });

  it("dropped dep with other reverse-deps is NOT an orphan", async () => {
    fakes.setMcp("file:/abs/mcp/x", "vendor/x", MCP_BODY);
    fakes.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", "1.0.0", `dependencies:\n  mcps:\n    - "file:/abs/mcp/x"`),
    });
    fakes.setSkill("file:/abs/sibling", {
      "SKILL.md": SKILL_ANCHOR(
        "sibling",
        "1.0.0",
        `dependencies:\n  mcps:\n    - "file:/abs/mcp/x"`,
      ),
    });
    await mgr.installSkill("file:/abs/tool");
    await mgr.installSkill("file:/abs/sibling");

    fakes.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool", "1.1.0") });
    const plan = await mgr.resolveSyncSkill("public/tool");
    expect(plan.orphans).toHaveLength(0);
  });

  it("applySync flags orphans and recompute clears them when a new dep arrives", async () => {
    fakes.setMcp("file:/abs/mcp/x", "vendor/x", MCP_BODY);
    fakes.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", "1.0.0", `dependencies:\n  mcps:\n    - "file:/abs/mcp/x"`),
    });
    await mgr.installSkill("file:/abs/tool");

    // Drop the dep + sync
    fakes.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool", "1.1.0") });
    const plan = await mgr.resolveSyncSkill("public/tool");
    const result = await mgr.applySync(plan);
    // applySync result includes the orphans surfaced by the diff.
    expect(result.orphansFlagged).toHaveLength(1);
    expect(result.orphansFlagged[0]).toMatchObject({ kind: "mcp", fqn: "vendor/x" });
    const orphaned = await mgr.getMcp("vendor/x");
    expect(orphaned?.orphaned).toBe(true);

    // Install a NEW skill that references the orphan again — recompute
    // should auto-clear the orphan flag.
    fakes.setSkill("file:/abs/restorer", {
      "SKILL.md": SKILL_ANCHOR(
        "restorer",
        "1.0.0",
        `dependencies:\n  mcps:\n    - "file:/abs/mcp/x"`,
      ),
    });
    await mgr.installSkill("file:/abs/restorer");
    const restored = await mgr.getMcp("vendor/x");
    expect(restored?.orphaned).toBe(false);
  });
});

describe("sync resolve — prereq carry-over", () => {
  it("preserves prereqsAck when prereqs text is unchanged across sync", async () => {
    fakes.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", "1.0.0", "prereqs: 'install foo'"),
    });
    await mgr.installSkill("file:/abs/tool");
    let s = await mgr.getSkill("public/tool");
    expect(s?.prereqsAck).toBe(false);

    await mgr.acknowledgeSkillPrereqs("public/tool");
    s = await mgr.getSkill("public/tool");
    expect(s?.prereqsAck).toBe(true);

    // Bump version but keep the prereqs text the same
    fakes.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", "1.1.0", "prereqs: 'install foo'"),
    });
    const plan = await mgr.resolveSyncSkill("public/tool");
    await mgr.applySync(plan);
    s = await mgr.getSkill("public/tool");
    expect(s?.prereqsAck).toBe(true);
  });

  it("resets prereqsAck when prereqs text changes", async () => {
    fakes.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", "1.0.0", "prereqs: 'install foo'"),
    });
    await mgr.installSkill("file:/abs/tool");
    await mgr.acknowledgeSkillPrereqs("public/tool");

    fakes.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", "1.1.0", "prereqs: 'install foo AND bar'"),
    });
    const plan = await mgr.resolveSyncSkill("public/tool");
    await mgr.applySync(plan);
    const s = await mgr.getSkill("public/tool");
    expect(s?.prereqsAck).toBe(false);
  });
});

describe("install — prereq default", () => {
  it("install with prereqs lands prereqsAck = false", async () => {
    fakes.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", "1.0.0", "prereqs: 'do something'"),
    });
    await mgr.installSkill("file:/abs/tool");
    const s = await mgr.getSkill("public/tool");
    expect(s?.prereqsAck).toBe(false);
  });

  it("install without prereqs lands prereqsAck = true", async () => {
    fakes.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool") });
    await mgr.installSkill("file:/abs/tool");
    const s = await mgr.getSkill("public/tool");
    expect(s?.prereqsAck).toBe(true);
  });
});

describe("recursive cascade computeStatus", () => {
  it("agent is blocked when its skill dep is blocked due to prereqs", async () => {
    fakes.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", "1.0.0", "prereqs: 'do this'"),
    });
    fakes.setAgent("file:/abs/agent", {
      "AGENTS.md": AGENT_ANCHOR(
        "researcher",
        "1.0.0",
        `dependencies:\n  skills:\n    - "file:/abs/tool"`,
      ),
    });
    await mgr.installAgent("file:/abs/agent");

    const entries = await mgr.listAgentEntries();
    const agent = entries.find((e) => e.agent.fqn === "public/researcher");
    expect(agent?.status).toBe("blocked");
    expect(agent?.blockedReason?.blockedDeps).toContainEqual({ kind: "skill", fqn: "public/tool" });
  });

  it("acknowledging the skill's prereqs unblocks the agent", async () => {
    fakes.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", "1.0.0", "prereqs: 'do this'"),
    });
    fakes.setAgent("file:/abs/agent", {
      "AGENTS.md": AGENT_ANCHOR(
        "researcher",
        "1.0.0",
        `dependencies:\n  skills:\n    - "file:/abs/tool"`,
      ),
    });
    await mgr.installAgent("file:/abs/agent");
    await mgr.acknowledgeSkillPrereqs("public/tool");

    const entries = await mgr.listAgentEntries();
    expect(entries[0]?.status).toBe("ready");
  });

  it("disabling an agent does NOT cascade to its skills (agent is a leaf for cascade)", async () => {
    fakes.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool") });
    fakes.setAgent("file:/abs/agent", {
      "AGENTS.md": AGENT_ANCHOR(
        "researcher",
        "1.0.0",
        `dependencies:\n  skills:\n    - "file:/abs/tool"`,
      ),
    });
    await mgr.installAgent("file:/abs/agent");
    await mgr.disableAgent("public/researcher");

    const skills = await mgr.listSkillEntries();
    expect(skills.find((s) => s.skill.fqn === "public/tool")?.status).toBe("ready");
  });
});
