import { DatabaseSync } from "node:sqlite";
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
import { HasDependentsError } from "../../src/facade/errors.js";
import { Mcp } from "../../src/mcp/mcp-entity.js";
import * as McpFormat from "../../src/mcp/mcp-format.js";
import { McpService } from "../../src/mcp/mcp-service.js";
import { SqliteMcpRepository } from "../../src/mcp/sqlite-mcp-repository.js";
import { CyclicDependencyError } from "../../src/skill/errors.js";
import { type SkillFetcher, SkillService } from "../../src/skill/skill-service.js";
import { SqliteSkillRepository } from "../../src/skill/sqlite-skill-repository.js";

/**
 * Shared fake fetcher: one in-memory map of (origin → file map) used
 * across all three services. Tests register fixtures via `setSkill`,
 * `setAgent`, `setMcp`, then drive the catalog through the facade.
 */
function makeFakeFetchers(): {
  skillFetcher: SkillFetcher;
  agentFetcher: AgentFetcher;
  mcpResolveAdapter: McpResolveAdapter;
  mcpFetchFile: (origin: string) => Promise<string>;
  setSkill: (origin: string, files: Record<string, string>) => void;
  setAgent: (origin: string, files: Record<string, string>) => void;
  setMcp: (origin: string, name: string, content: string) => void;
} {
  const trees = new Map<string, Map<string, Buffer>>();
  const mcpStore = new Map<string, { origin: string; content: string }>();

  function tree(origin: string): Map<string, Buffer> {
    const t = trees.get(origin);
    if (t === undefined) throw new Error(`fake fetcher: no fixture for ${origin}`);
    return t;
  }

  const skillFetcher: SkillFetcher = {
    async fetchAnchor(origin) {
      const anchor = tree(origin).get("SKILL.md");
      if (anchor === undefined) throw new Error(`no SKILL.md at ${origin}`);
      return anchor.toString("utf8");
    },
    async *fetchTree(origin) {
      for (const [relPath, content] of tree(origin)) {
        yield { relPath, content } satisfies EntryFile;
      }
    },
  };
  const agentFetcher: AgentFetcher = {
    async fetchAnchor(origin) {
      const anchor = tree(origin).get("AGENTS.md");
      if (anchor === undefined) throw new Error(`no AGENTS.md at ${origin}`);
      return anchor.toString("utf8");
    },
    async *fetchTree(origin) {
      for (const [relPath, content] of tree(origin)) {
        yield { relPath, content } satisfies EntryFile;
      }
    },
  };
  const mcpFetchFile = async (origin: string): Promise<string> => {
    const store = mcpStore.get(origin);
    if (store === undefined) throw new Error(`no MCP at ${origin}`);
    return store.content;
  };
  const mcpResolveAdapter: McpResolveAdapter = async (origin) => {
    const store = mcpStore.get(origin);
    if (store === undefined) {
      const conflict: CatalogConflict = {
        kind: "mcp",
        origin,
        fqn: null,
        reason: { kind: "fetch-failed", cause: new Error(`no MCP at ${origin}`) },
      };
      return { node: null, conflict };
    }
    // Mirror production: parse _meta.name from content to recover FQN,
    // then re-stamp `name` (origin is NOT carried in the file).
    const parsed = McpFormat.parse(store.content, `resolve:${origin}`);
    const name = parsed.meta.name;
    const merged = McpFormat.writeMeta(store.content, { name }, `resolve:${origin}`);
    const node: McpResolvedNode = { fqn: name, origin, content: merged };
    return { node, conflict: null };
  };

  return {
    skillFetcher,
    agentFetcher,
    mcpResolveAdapter,
    mcpFetchFile,
    setSkill(origin, files) {
      const map = new Map<string, Buffer>();
      for (const [k, v] of Object.entries(files)) map.set(k, Buffer.from(v, "utf8"));
      trees.set(origin, map);
    },
    setAgent(origin, files) {
      const map = new Map<string, Buffer>();
      for (const [k, v] of Object.entries(files)) map.set(k, Buffer.from(v, "utf8"));
      trees.set(origin, map);
    },
    setMcp(origin, name, content) {
      // Pre-merge _meta.name into the stored content so resolveMcp can
      // derive the FQN by parsing — mirrors how a real fetcher would
      // serve a manifest with `_meta.name` baked in.
      const merged = McpFormat.writeMeta(content, { name }, `seed:${origin}`);
      mcpStore.set(origin, { origin, content: merged });
      // Also stash in trees so McpService.install (which uses the
      // tree-based fetcher) can read it back.
      const map = new Map<string, Buffer>();
      map.set("mcp.json", Buffer.from(merged, "utf8"));
      trees.set(origin, map);
    },
  };
}

const SKILL_ANCHOR = (name: string, deps = "") => `---
name: ${name}
description: x
version: 1.0.0
${deps}
---
# Body
`;

const AGENT_ANCHOR = (name: string, deps = "") => `---
name: ${name}
description: x
version: 1.0.0
${deps}
---
# Body
`;

const MCP_BODY = `{
  "command": "node",
  "args": ["server.js"]
}`;

let db: DatabaseSync;
let mcpRepo: SqliteMcpRepository;
let skillRepo: SqliteSkillRepository;
let agentRepo: SqliteAgentRepository;
let fetchers: ReturnType<typeof makeFakeFetchers>;
let mgr: CatalogManager;

beforeEach(() => {
  // All three catalog repos share one in-memory connection — same as
  // production where they share the workspace's `workspace.db` handle.
  db = new DatabaseSync(":memory:");
  mcpRepo = new SqliteMcpRepository({ db });
  skillRepo = new SqliteSkillRepository({ db });
  agentRepo = new SqliteAgentRepository({ db });
  fetchers = makeFakeFetchers();

  // McpService is wired against a single-file fetcher that returns
  // the registered mcp.json content for each origin.
  const mcpSvc = new McpService(mcpRepo, fetchers.mcpFetchFile);
  const skillSvc = new SkillService(skillRepo, fetchers.skillFetcher);
  const agentSvc = new AgentService(agentRepo, fetchers.agentFetcher);
  mgr = new CatalogManager(mcpSvc, skillSvc, agentSvc, fetchers.mcpResolveAdapter);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
});

// ─── resolveSkill: cross-entity walking ─────────────────

describe("CatalogManager.resolveSkill", () => {
  it("resolves a leaf skill (no deps)", async () => {
    fetchers.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool") });
    const plan = await mgr.resolveSkill("file:/abs/tool");
    expect(plan.toInstall).toHaveLength(1);
    expect(plan.toInstall[0]?.kind).toBe("skill");
    expect(plan.toInstall[0]?.node.fqn).toBe("public/tool");
    expect(plan.alreadyInstalled).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("walks transitive skill deps in dep-first order", async () => {
    fetchers.setSkill("file:/abs/c", { "SKILL.md": SKILL_ANCHOR("c") });
    fetchers.setSkill("file:/abs/b", {
      "SKILL.md": SKILL_ANCHOR("b", `dependencies:\n  skills:\n    - "file:/abs/c"`),
    });
    fetchers.setSkill("file:/abs/a", {
      "SKILL.md": SKILL_ANCHOR("a", `dependencies:\n  skills:\n    - "file:/abs/b"`),
    });
    const plan = await mgr.resolveSkill("file:/abs/a");
    const fqns = plan.toInstall.map((n) => n.node.fqn);
    expect(fqns).toEqual(["public/c", "public/b", "public/a"]);
  });

  it("includes mcp deps in the plan, in dep-first order (mcps before the skill that depends on them)", async () => {
    fetchers.setMcp("file:/abs/mcp/azure", "azure/mcp", MCP_BODY);
    fetchers.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", `dependencies:\n  mcps:\n    - "file:/abs/mcp/azure"`),
    });
    const plan = await mgr.resolveSkill("file:/abs/tool");
    expect(plan.toInstall.map((n) => `${n.kind}:${n.node.fqn}`)).toEqual([
      "mcp:azure/mcp",
      "skill:public/tool",
    ]);
  });

  it("dedupes shared deps (diamond): mcp X referenced by skills A and B is included once", async () => {
    fetchers.setMcp("file:/abs/mcp/x", "vendor/x", MCP_BODY);
    fetchers.setSkill("file:/abs/a", {
      "SKILL.md": SKILL_ANCHOR("a", `dependencies:\n  mcps:\n    - "file:/abs/mcp/x"`),
    });
    fetchers.setSkill("file:/abs/b", {
      "SKILL.md": SKILL_ANCHOR("b", `dependencies:\n  mcps:\n    - "file:/abs/mcp/x"`),
    });
    fetchers.setSkill("file:/abs/root", {
      "SKILL.md": SKILL_ANCHOR(
        "root",
        `dependencies:\n  skills:\n    - "file:/abs/a"\n    - "file:/abs/b"`,
      ),
    });
    const plan = await mgr.resolveSkill("file:/abs/root");
    const mcpNodes = plan.toInstall.filter((n) => n.kind === "mcp");
    expect(mcpNodes).toHaveLength(1);
    expect(mcpNodes[0]?.node.fqn).toBe("vendor/x");
  });

  it("surfaces upstream conflicts without aborting the whole resolve", async () => {
    fetchers.setSkill("file:/abs/parent", {
      "SKILL.md": SKILL_ANCHOR("parent", `dependencies:\n  skills:\n    - "file:/abs/missing"`),
    });
    // file:./missing is never registered — fetch fails.
    const plan = await mgr.resolveSkill("file:/abs/parent");
    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(plan.conflicts[0]?.kind).toBe("skill");
    expect(plan.conflicts[0]?.reason.kind).toBe("fetch-failed");
    // Parent itself still resolves
    expect(plan.toInstall.some((n) => n.node.fqn === "public/parent")).toBe(true);
  });

  it("rejects a self-referential skill (A depends on A)", async () => {
    // Direct self-loop is the simplest cycle case.
    fetchers.setSkill("file:/abs/a", {
      "SKILL.md": SKILL_ANCHOR("a", `dependencies:\n  skills:\n    - "file:/abs/a"`),
    });
    await expect(mgr.resolveSkill("file:/abs/a")).rejects.toBeInstanceOf(CyclicDependencyError);
  });

  it("rejects a two-skill cycle (A → B → A)", async () => {
    fetchers.setSkill("file:/abs/a", {
      "SKILL.md": SKILL_ANCHOR("a", `dependencies:\n  skills:\n    - "file:/abs/b"`),
    });
    fetchers.setSkill("file:/abs/b", {
      "SKILL.md": SKILL_ANCHOR("b", `dependencies:\n  skills:\n    - "file:/abs/a"`),
    });
    const err = await mgr.resolveSkill("file:/abs/a").then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(CyclicDependencyError);
    // The path includes both nodes plus the back-edge target so the
    // user can read the cycle off the message.
    expect((err as CyclicDependencyError).cycle).toEqual([
      "file:/abs/a",
      "file:/abs/b",
      "file:/abs/a",
    ]);
  });

  it("rejects a longer cycle (A → B → C → A) with the full path", async () => {
    fetchers.setSkill("file:/abs/a", {
      "SKILL.md": SKILL_ANCHOR("a", `dependencies:\n  skills:\n    - "file:/abs/b"`),
    });
    fetchers.setSkill("file:/abs/b", {
      "SKILL.md": SKILL_ANCHOR("b", `dependencies:\n  skills:\n    - "file:/abs/c"`),
    });
    fetchers.setSkill("file:/abs/c", {
      "SKILL.md": SKILL_ANCHOR("c", `dependencies:\n  skills:\n    - "file:/abs/a"`),
    });
    const err = await mgr.resolveSkill("file:/abs/a").then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(CyclicDependencyError);
    expect((err as CyclicDependencyError).cycle).toEqual([
      "file:/abs/a",
      "file:/abs/b",
      "file:/abs/c",
      "file:/abs/a",
    ]);
  });

  it("accepts a diamond (A → B, A → C, B → C) — same fqn via two paths is NOT a cycle", async () => {
    // Classic shape: C is a shared dep of A and B, and A also
    // depends on C directly. The previous regression ("dedupes
    // shared deps") covered the simpler diamond via dedupe, but
    // this test is specifically about the cycle-detection split:
    // C is reached as a dep of B (currently in DFS stack) but
    // C itself never sits on a path leading back to A or B.
    fetchers.setSkill("file:/abs/c", { "SKILL.md": SKILL_ANCHOR("c") });
    fetchers.setSkill("file:/abs/b", {
      "SKILL.md": SKILL_ANCHOR("b", `dependencies:\n  skills:\n    - "file:/abs/c"`),
    });
    fetchers.setSkill("file:/abs/a", {
      "SKILL.md": SKILL_ANCHOR(
        "a",
        `dependencies:\n  skills:\n    - "file:/abs/b"\n    - "file:/abs/c"`,
      ),
    });
    const plan = await mgr.resolveSkill("file:/abs/a");
    // C, B, A — dep-first, C deduped to a single entry.
    expect(plan.toInstall.map((n) => n.node.fqn)).toEqual(["public/c", "public/b", "public/a"]);
    expect(plan.conflicts).toEqual([]);
  });

  it("cycle inside an agent's transitive skill graph propagates as CyclicDependencyError", async () => {
    // Cycles can only form among skills (mcps have no deps,
    // agents are never dep-referenced). An agent whose deps
    // happen to reach a cycle still surfaces the error from
    // walkSkill — the catch-it-once pattern in walkAgent doesn't
    // get a chance to swallow it.
    fetchers.setSkill("file:/abs/a", {
      "SKILL.md": SKILL_ANCHOR("a", `dependencies:\n  skills:\n    - "file:/abs/b"`),
    });
    fetchers.setSkill("file:/abs/b", {
      "SKILL.md": SKILL_ANCHOR("b", `dependencies:\n  skills:\n    - "file:/abs/a"`),
    });
    fetchers.setAgent("file:/abs/agent", {
      "AGENTS.md": AGENT_ANCHOR("agent", `dependencies:\n  skills:\n    - "file:/abs/a"`),
    });
    await expect(mgr.resolveAgentFromOrigin("file:/abs/agent")).rejects.toBeInstanceOf(
      CyclicDependencyError,
    );
  });
});

// ─── resolveAgent: cross-entity walking ─────────────────

describe("CatalogManager.resolveAgent", () => {
  it("resolves an agent with skill + mcp deps", async () => {
    fetchers.setMcp("file:/abs/mcp/azure", "azure/mcp", MCP_BODY);
    fetchers.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool") });
    fetchers.setAgent("file:/abs/researcher", {
      "AGENTS.md": AGENT_ANCHOR(
        "researcher",
        `dependencies:
  skills:
    - "file:/abs/tool"
  mcps:
    - "file:/abs/mcp/azure"`,
      ),
    });
    const plan = await mgr.resolveAgentFromOrigin("file:/abs/researcher");
    const ordered = plan.toInstall.map((n) => `${n.kind}:${n.node.fqn}`);
    // mcps first, skills middle, agent last
    expect(ordered).toEqual(["mcp:azure/mcp", "skill:public/tool", "agent:public/researcher"]);
  });
});

// ─── install: cross-entity orchestration ────────────────

describe("CatalogManager.install", () => {
  it("installs all three kinds in topological order", async () => {
    fetchers.setMcp("file:/abs/mcp/azure", "azure/mcp", MCP_BODY);
    fetchers.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool") });
    fetchers.setAgent("file:/abs/researcher", {
      "AGENTS.md": AGENT_ANCHOR(
        "researcher",
        `dependencies:
  skills:
    - "file:/abs/tool"
  mcps:
    - "file:/abs/mcp/azure"`,
      ),
    });
    const result = await mgr.installAgent("file:/abs/researcher");
    expect(result.failed).toEqual([]);
    expect(result.installed.map((n) => `${n.kind}:${n.fqn}`)).toEqual([
      "mcp:azure/mcp",
      "skill:public/tool",
      "agent:public/researcher",
    ]);
    // All three are queryable
    expect(await mgr.getMcp("azure/mcp")).not.toBeNull();
    expect(await mgr.getSkill("public/tool")).not.toBeNull();
    expect(await mgr.getAgent("public/researcher")).not.toBeNull();
  });

  it("a failed dep poisons its dependents (failure propagation)", async () => {
    // mcp registered with content that survives resolve but fails install
    // (we'll simulate by leaving it unregistered for the install-time fetch).
    fetchers.setMcp("file:/abs/mcp/x", "vendor/x", MCP_BODY);
    fetchers.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", `dependencies:\n  mcps:\n    - "file:/abs/mcp/x"`),
    });
    const plan = await mgr.resolveSkill("file:/abs/tool");
    expect(plan.toInstall.length).toBe(2);

    // Sabotage MCP install: clobber the tree fixture so the install-
    // time tree fetch fails for the mcp.
    // (simulate by removing the registered tree)
    // The mcp resolve adapter doesn't re-fetch, so resolve already
    // captured the "good" content. Install hits `mcpService.install`
    // which now writes the content that the adapter already gave it
    // — so we have to sabotage somewhere else. Use a content that
    // will fail McpFormat parse on install.
    // Easier: bump the plan's mcp content to invalid JSON.
    const mutated = {
      ...plan,
      toInstall: plan.toInstall.map((n) =>
        n.kind === "mcp" ? { ...n, node: { ...n.node, content: "{{not valid json" } } : n,
      ),
    };
    const result = await mgr.install(mutated);
    expect(result.failed.some((f) => f.kind === "mcp")).toBe(true);
    expect(result.skipped.some((s) => s.kind === "skill" && s.reason === "dep-failed")).toBe(true);
    // Wire-safety: the failure entry's `error` is a plain `{ name, message }`
    // payload — not an `Error` instance — so JSON serialization preserves it.
    const mcpFailure = result.failed.find((f) => f.kind === "mcp");
    expect(mcpFailure?.error.name).toBeTypeOf("string");
    expect(mcpFailure?.error.message).toBeTypeOf("string");
    expect(mcpFailure?.error.message.length).toBeGreaterThan(0);
    // Round-trip through JSON to confirm clients see the actual fields.
    const roundTripped = JSON.parse(JSON.stringify(mcpFailure));
    expect(roundTripped.error).toEqual({
      name: mcpFailure?.error.name,
      message: mcpFailure?.error.message,
    });
  });

  it("already-installed deps are skipped, not re-installed", async () => {
    fetchers.setMcp("file:/abs/mcp/x", "vendor/x", MCP_BODY);
    // Pre-install the mcp
    await mgr.installMcpFromOrigin("file:/abs/mcp/x", "vendor/x");

    fetchers.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", `dependencies:\n  mcps:\n    - "file:/abs/mcp/x"`),
    });
    const result = await mgr.installSkill("file:/abs/tool");
    expect(result.installed.map((n) => n.fqn)).toContain("public/tool");
    expect(result.installed.map((n) => n.fqn)).not.toContain("vendor/x");
    expect(
      result.skipped.some((s) => s.fqn === "vendor/x" && s.reason === "already-installed"),
    ).toBe(true);
  });
});

// ─── delete with dep protection ─────────────────────

describe("CatalogManager — delete with dep protection", () => {
  it("deleteAgent works unconditionally (agents are roots)", async () => {
    fetchers.setAgent("file:/abs/agent", { "AGENTS.md": AGENT_ANCHOR("agent") });
    await mgr.installAgent("file:/abs/agent");
    await mgr.deleteAgent("public/agent");
    expect(await mgr.getAgent("public/agent")).toBeNull();
  });

  it("deleteSkill refuses if another skill depends on it", async () => {
    fetchers.setSkill("file:/abs/child", { "SKILL.md": SKILL_ANCHOR("child") });
    fetchers.setSkill("file:/abs/parent", {
      "SKILL.md": SKILL_ANCHOR("parent", `dependencies:\n  skills:\n    - "file:/abs/child"`),
    });
    await mgr.installSkill("file:/abs/parent");
    await expect(mgr.deleteSkill("public/child")).rejects.toThrow(HasDependentsError);
  });

  it("deleteSkill works after the dependent is removed", async () => {
    fetchers.setSkill("file:/abs/child", { "SKILL.md": SKILL_ANCHOR("child") });
    fetchers.setSkill("file:/abs/parent", {
      "SKILL.md": SKILL_ANCHOR("parent", `dependencies:\n  skills:\n    - "file:/abs/child"`),
    });
    await mgr.installSkill("file:/abs/parent");
    await mgr.deleteSkill("public/parent");
    await mgr.deleteSkill("public/child");
    expect(await mgr.getSkill("public/child")).toBeNull();
  });

  it("deleteMcp refuses if a skill depends on it", async () => {
    fetchers.setMcp("file:/abs/mcp/x", "vendor/x", MCP_BODY);
    fetchers.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", `dependencies:\n  mcps:\n    - "file:/abs/mcp/x"`),
    });
    await mgr.installSkill("file:/abs/tool");
    await expect(mgr.deleteMcp("vendor/x")).rejects.toThrow(HasDependentsError);
  });

  it("deleteMcp refuses if an agent depends on it", async () => {
    fetchers.setMcp("file:/abs/mcp/x", "vendor/x", MCP_BODY);
    fetchers.setAgent("file:/abs/agent", {
      "AGENTS.md": AGENT_ANCHOR("agent", `dependencies:\n  mcps:\n    - "file:/abs/mcp/x"`),
    });
    await mgr.installAgent("file:/abs/agent");
    await expect(mgr.deleteMcp("vendor/x")).rejects.toThrow(HasDependentsError);
  });

  it("findDependents lists all referrers", async () => {
    fetchers.setMcp("file:/abs/mcp/x", "vendor/x", MCP_BODY);
    fetchers.setSkill("file:/abs/tool", {
      "SKILL.md": SKILL_ANCHOR("tool", `dependencies:\n  mcps:\n    - "file:/abs/mcp/x"`),
    });
    fetchers.setAgent("file:/abs/agent", {
      "AGENTS.md": AGENT_ANCHOR("agent", `dependencies:\n  mcps:\n    - "file:/abs/mcp/x"`),
    });
    await mgr.installSkill("file:/abs/tool");
    await mgr.installAgent("file:/abs/agent");
    const deps = await mgr.findDependents("vendor/x");
    expect(deps.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { kind: "agent", name: "public/agent" },
      { kind: "skill", name: "public/tool" },
    ]);
  });
});

// ─── single-shot convenience ────────────────────────

describe("CatalogManager — single-shot installers", () => {
  it("installSkill is resolveSkill + install", async () => {
    fetchers.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool") });
    const result = await mgr.installSkill("file:/abs/tool");
    expect(result.installed[0]?.fqn).toBe("public/tool");
  });

  it("installAgent is resolveAgent + install", async () => {
    fetchers.setAgent("file:/abs/agent", { "AGENTS.md": AGENT_ANCHOR("agent") });
    const result = await mgr.installAgent("file:/abs/agent");
    expect(result.installed[0]?.fqn).toBe("public/agent");
  });

  it("installMcp is resolveMcp + install", async () => {
    fetchers.setMcp("file:/abs/mcp/x", "vendor/x", MCP_BODY);
    const result = await mgr.installMcpFromOrigin("file:/abs/mcp/x", "vendor/x");
    expect(result.installed[0]?.fqn).toBe("vendor/x");
  });
});

// ─── Plan token cache (preview/apply UX backbone) ────────────

describe("CatalogManager plan token cache", () => {
  it("cachePlan returns a single-use token that takePlan trades for the plan", async () => {
    fetchers.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool") });
    const plan = await mgr.resolveSkill("file:/abs/tool");
    const token = mgr.cachePlan(plan);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    // First take returns the same plan instance.
    expect(mgr.takePlan(token)).toBe(plan);
    // Single-use: second take returns null even though the call shape
    // is identical. Defends against UI double-click re-running install.
    expect(mgr.takePlan(token)).toBeNull();
  });

  it("takePlan returns null for an unknown token (no false-positive on similar UUID)", () => {
    expect(mgr.takePlan("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("each cachePlan call mints a fresh token (no aliasing on identical plans)", async () => {
    fetchers.setSkill("file:/abs/tool", { "SKILL.md": SKILL_ANCHOR("tool") });
    const plan = await mgr.resolveSkill("file:/abs/tool");
    const token1 = mgr.cachePlan(plan);
    const token2 = mgr.cachePlan(plan);
    expect(token1).not.toBe(token2);
    // Both tokens are independently consumable.
    expect(mgr.takePlan(token1)).toBe(plan);
    expect(mgr.takePlan(token2)).toBe(plan);
  });
});

void Mcp; // satisfy unused-import check; we reference it elsewhere via type
