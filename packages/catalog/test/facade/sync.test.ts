import { DatabaseSync } from "node:sqlite";
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
import { CyclicDependencyError } from "../../src/skill/errors.js";
import { type SkillFetcher, SkillService } from "../../src/skill/skill-service.js";
import { SqliteSkillRepository } from "../../src/skill/sqlite-skill-repository.js";
import { bootstrapCatalogDbSync } from "../helpers/bootstrap.js";

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
  mcpFetchFile: (origin: string) => Promise<string>;
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
  const mcpFetchFile = async (o: string): Promise<string> => {
    const s = mcpStore.get(o);
    if (s === undefined) throw new Error(`no MCP at ${o}`);
    return s.content;
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
    const merged = McpFormat.writeMeta(s.content, { name: parsed.meta.name }, `resolve:${origin}`);
    const node: McpResolvedNode = { fqn: parsed.meta.name, origin, content: merged };
    return { node, conflict: null };
  };
  return {
    skillFetcher,
    agentFetcher,
    mcpResolveAdapter,
    mcpFetchFile,
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
      const merged = McpFormat.writeMeta(content, { name }, `seed:${o}`);
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

let db: DatabaseSync;
let mcpRepo: SqliteMcpRepository;
let skillRepo: SqliteSkillRepository;
let agentRepo: SqliteAgentRepository;
let fakes: Fakes;
let mgr: CatalogManager;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  bootstrapCatalogDbSync(db);
  mcpRepo = new SqliteMcpRepository({ db });
  skillRepo = new SqliteSkillRepository({ db });
  agentRepo = new SqliteAgentRepository({ db });
  fakes = makeFakes();
  const mcpSvc = new McpService(mcpRepo, fakes.mcpFetchFile);
  const skillSvc = new SkillService(skillRepo, fakes.skillFetcher);
  const agentSvc = new AgentService(agentRepo, fakes.agentFetcher);
  mgr = new CatalogManager(mcpSvc, skillSvc, agentSvc, fakes.mcpResolveAdapter);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
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

  it("MCP up-to-date check uses content digest (no `version` field on MCPs)", async () => {
    // MCPs don't carry a `version` field — author contract for
    // "did anything change" is the file content itself, hashed
    // with `_meta` stripped (so install-time stamping of
    // `_meta.name` doesn't show as a spurious diff). Same upstream
    // bytes → up-to-date. Different bytes → will-sync.
    fakes.setMcp("file:/abs/mcp/x", "vendor/x", '{"command": "node", "args": ["v1.js"]}');
    await mgr.installMcpFromOrigin("file:/abs/mcp/x");

    // Same content — sync should report up-to-date.
    let plan = await mgr.resolveSyncMcp("vendor/x");
    expect(plan.upToDate).toBe(true);
    expect(plan.toInstall).toHaveLength(0);

    // Drift the upstream content (without changing the spec name).
    fakes.setMcp("file:/abs/mcp/x", "vendor/x", '{"command": "node", "args": ["v2.js"]}');
    plan = await mgr.resolveSyncMcp("vendor/x");
    expect(plan.upToDate).toBe(false);
    expect(plan.toInstall.find((n) => n.node.fqn === "vendor/x")?.disposition).toBe("will-sync");
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

  it("removing an agent flips its dep skill to orphan (live derivation, no flag write)", async () => {
    // Regression for the gap where `deleteAgent` did not propagate
    // orphan status to the skills it depended on. Under the new
    // derived model the answer is computed from the live dep graph
    // each time a wire DTO is projected, so the right thing happens
    // automatically — no flag-marking pass needed.
    fakes.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool", "1.0.0") });
    fakes.setAgent("file:/abs/agent", {
      "AGENTS.md": AGENT_ANCHOR(
        "writer",
        "1.0.0",
        `dependencies:\n  skills:\n    - "file:/abs/tool"`,
      ),
    });
    await mgr.installAgent("file:/abs/agent");

    // While the agent exists, the tool skill has a reverse-dep and
    // is not orphan.
    let tool = await mgr.getSkill("public/tool");
    expect(tool?.orphaned).toBe(false);

    await mgr.deleteAgent("public/writer");

    // Removing the agent leaves the tool with zero reverse-deps —
    // it should now read as orphan from the very next projection.
    tool = await mgr.getSkill("public/tool");
    expect(tool?.orphaned).toBe(true);
  });

  it("rejects a self-referential skill at install time (degenerate cycle)", async () => {
    // Originally raised during code review as "degenerate but legal";
    // subsequent review tightened the contract — emploke refuses
    // cyclic catalog deps at resolve/install (see CyclicDependencyError),
    // and self-ref is the simplest cycle. With install-time rejection
    // in place, the orphan-derivation paths in `newCascadeContext`
    // and `computeReverseDepIndex` no longer need defensive self-ref
    // filtering: a self-referencing skill cannot exist in a
    // well-formed catalog. If a future bypass path (direct SQLite
    // write, FS edit) ever produces one, the right fix is a
    // catalog-load integrity check, not patching every consumer.
    fakes.setSkill("file:/abs/loner", {
      "SKILL.md": SKILL_ANCHOR(
        "loner",
        "1.0.0",
        `dependencies:\n  skills:\n    - "file:/abs/loner"`,
      ),
    });
    await expect(mgr.installSkill("file:/abs/loner")).rejects.toBeInstanceOf(CyclicDependencyError);
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

describe("install / sync result — prereqs surfaced on installed[]", () => {
  it("installed[] for a new skill with prereqs surfaces prereqs + prereqsAck=false", async () => {
    fakes.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", "1.0.0", "prereqs: 'install foo'"),
    });
    const result = await mgr.installSkill("file:/abs/tool");
    expect(result.installed).toHaveLength(1);
    const entry = result.installed[0];
    expect(entry?.kind).toBe("skill");
    expect(entry?.fqn).toBe("public/tool");
    expect(entry?.prereqs).toBe("install foo");
    expect(entry?.prereqsAck).toBe(false);
  });

  it("installed[] for a skill without prereqs omits the prereqs field", async () => {
    fakes.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool") });
    const result = await mgr.installSkill("file:/abs/tool");
    const entry = result.installed[0];
    expect(entry?.prereqs).toBeUndefined();
    expect(entry?.prereqsAck).toBe(true);
  });

  it("installed[] for an mcp omits prereqs and prereqsAck", async () => {
    fakes.setMcp("file:/abs/mcp/x", "vendor/x", MCP_BODY);
    const result = await mgr.installMcpFromOrigin("file:/abs/mcp/x");
    const entry = result.installed[0];
    expect(entry?.kind).toBe("mcp");
    expect(entry?.prereqs).toBeUndefined();
    expect(entry?.prereqsAck).toBeUndefined();
  });

  it("sync re-ack: changing prereqs text resets prereqsAck and surfaces it on installed[]", async () => {
    fakes.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", "1.0.0", "prereqs: 'install foo'"),
    });
    await mgr.installSkill("file:/abs/tool");
    await mgr.acknowledgeSkillPrereqs("public/tool");

    fakes.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", "1.1.0", "prereqs: 'install foo AND bar'"),
    });
    const plan = await mgr.resolveSyncSkill("public/tool");
    const result = await mgr.applySync(plan);
    const entry = result.installed.find((e) => e.fqn === "public/tool");
    expect(entry?.prereqs).toBe("install foo AND bar");
    expect(entry?.prereqsAck).toBe(false);
  });

  it("sync with unchanged prereqs text preserves prereqsAck=true on installed[]", async () => {
    fakes.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", "1.0.0", "prereqs: 'install foo'"),
    });
    await mgr.installSkill("file:/abs/tool");
    await mgr.acknowledgeSkillPrereqs("public/tool");

    // Bump version but keep prereqs identical
    fakes.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", "1.1.0", "prereqs: 'install foo'"),
    });
    const plan = await mgr.resolveSyncSkill("public/tool");
    const result = await mgr.applySync(plan);
    const entry = result.installed.find((e) => e.fqn === "public/tool");
    expect(entry?.prereqs).toBe("install foo");
    expect(entry?.prereqsAck).toBe(true);
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
