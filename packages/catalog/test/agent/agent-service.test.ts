import { DatabaseSync } from "node:sqlite";
import type { EntryFile } from "@emploke/catalog-fetcher";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent-entity.js";
import { type AgentFetcher, AgentService } from "../../src/agent/agent-service.js";
import {
  AgentFrontmatterError,
  AgentNotFoundError,
  AgentOriginConflictError,
  AgentPlanStaleError,
} from "../../src/agent/errors.js";
import { SqliteAgentRepository } from "../../src/agent/sqlite-agent-repository.js";

function makeFetcher(): {
  fetcher: AgentFetcher;
  set: (origin: string, files: Record<string, string>) => void;
} {
  const trees = new Map<string, Map<string, Buffer>>();
  const fetcher: AgentFetcher = {
    async fetchAnchor(origin) {
      const tree = trees.get(origin);
      if (tree === undefined) throw new Error(`fake fetcher: no fixture for ${origin}`);
      const anchor = tree.get("AGENTS.md");
      if (anchor === undefined) throw new Error(`fake fetcher: no AGENTS.md for ${origin}`);
      return anchor.toString("utf8");
    },
    async *fetchTree(origin) {
      const tree = trees.get(origin);
      if (tree === undefined) throw new Error(`fake fetcher: no fixture for ${origin}`);
      for (const [relPath, content] of tree) {
        yield { relPath, content } satisfies EntryFile;
      }
    },
  };
  return {
    fetcher,
    set(origin, files) {
      const map = new Map<string, Buffer>();
      for (const [k, v] of Object.entries(files)) map.set(k, Buffer.from(v, "utf8"));
      trees.set(origin, map);
    },
  };
}

const ANCHOR = (name: string, deps: string = "") => `---
name: ${name}
description: x
version: 1.0.0
${deps}
---
# Body
`;

let db: DatabaseSync;
let repo: SqliteAgentRepository;
let fetcher: ReturnType<typeof makeFetcher>;
let svc: AgentService;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  repo = new SqliteAgentRepository({ db });
  fetcher = makeFetcher();
  svc = new AgentService(repo, fetcher.fetcher);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
});

// ─── resolve ──────────────────────────────────────────────────

describe("AgentService.resolve", () => {
  it("returns a single-node plan for a leaf agent", async () => {
    fetcher.set("file:/abs/agent", { "AGENTS.md": ANCHOR("agent") });
    const plan = await svc.resolve("file:/abs/agent");
    expect(plan.conflict).toBeNull();
    expect(plan.node).not.toBeNull();
    expect(plan.node!.fqn).toBe("public/agent");
    expect(plan.node!.depsRefs.skills).toEqual([]);
    expect(plan.node!.depsRefs.mcps).toEqual([]);
  });

  it("captures the upstream version on the resolved node", async () => {
    fetcher.set("file:/abs/agent", { "AGENTS.md": ANCHOR("agent") });
    const plan = await svc.resolve("file:/abs/agent");
    expect(plan.node!.version).toBe("1.0.0");
  });

  it("surfaces dep refs (does NOT recurse — facade's job)", async () => {
    const deps = `dependencies:
  skills:
    - "file:/abs/skills/web-search"
  mcps:
    - "file:/abs/mcps/azure"`;
    fetcher.set("file:/abs/agent", { "AGENTS.md": ANCHOR("agent", deps) });
    const plan = await svc.resolve("file:/abs/agent");
    expect(plan.node!.depsRefs.skills).toEqual(["file:/abs/skills/web-search"]);
    expect(plan.node!.depsRefs.mcps).toEqual(["file:/abs/mcps/azure"]);
  });

  it("surfaces fetch failures as conflict", async () => {
    const plan = await svc.resolve("file:/abs/never");
    expect(plan.node).toBeNull();
    expect(plan.conflict?.reason.kind).toBe("fetch-failed");
  });

  it("surfaces parse failures as conflict", async () => {
    fetcher.set("file:/abs/bad", { "AGENTS.md": "no frontmatter" });
    const plan = await svc.resolve("file:/abs/bad");
    expect(plan.node).toBeNull();
    expect(plan.conflict?.reason.kind).toBe("parse-failed");
  });

  it("surfaces FQN-different-origin as conflict", async () => {
    fetcher.set("file:/abs/a", { "AGENTS.md": ANCHOR("agent") });
    await svc.install("file:/abs/a");

    fetcher.set("file:/abs/b", { "AGENTS.md": ANCHOR("agent") });
    const plan = await svc.resolve("file:/abs/b");
    expect(plan.conflict?.reason.kind).toBe("origin-conflict");
  });
});

// ─── install ──────────────────────────────────────────────────

describe("AgentService.install", () => {
  it("installs from origin string (resolve + install)", async () => {
    fetcher.set("file:/abs/agent", { "AGENTS.md": ANCHOR("agent"), "extra.txt": "extra" });
    const a = await svc.install("file:/abs/agent");
    expect(a.fqn).toBe("public/agent");
    const got = await svc.get("public/agent");
    expect(got).not.toBeNull();
    const files = new Map<string, Buffer>();
    for await (const f of svc.streamFiles("public/agent")) files.set(f.relPath, f.content);
    expect(files.get("extra.txt")?.toString("utf8")).toBe("extra");
  });

  it("installs from a resolved plan node", async () => {
    fetcher.set("file:/abs/agent", { "AGENTS.md": ANCHOR("agent") });
    const plan = await svc.resolve("file:/abs/agent");
    expect(plan.node).not.toBeNull();
    const a = await svc.install(plan.node!);
    expect(a.fqn).toBe("public/agent");
  });

  it("upserts content under same origin", async () => {
    fetcher.set("file:/abs/agent", { "AGENTS.md": ANCHOR("agent"), "data.txt": "v1" });
    await svc.install("file:/abs/agent");
    fetcher.set("file:/abs/agent", { "AGENTS.md": ANCHOR("agent"), "data.txt": "v2" });
    await svc.install("file:/abs/agent");
    const files = new Map<string, Buffer>();
    for await (const f of svc.streamFiles("public/agent")) files.set(f.relPath, f.content);
    expect(files.get("data.txt")?.toString("utf8")).toBe("v2");
  });

  it("rejects same FQN reinstall from different origin via resolve conflict", async () => {
    fetcher.set("file:/abs/a", { "AGENTS.md": ANCHOR("agent") });
    await svc.install("file:/abs/a");

    fetcher.set("file:/abs/b", { "AGENTS.md": ANCHOR("agent") });
    await expect(svc.install("file:/abs/b")).rejects.toThrow(AgentOriginConflictError);
  });

  it("throws AgentPlanStaleError when version changes between resolve and install", async () => {
    fetcher.set("file:/abs/agent", { "AGENTS.md": ANCHOR("agent") });
    const plan = await svc.resolve("file:/abs/agent");
    expect(plan.node).not.toBeNull();
    fetcher.set("file:/abs/agent", {
      "AGENTS.md": ANCHOR("agent").replace("1.0.0", "2.0.0"),
    });
    await expect(svc.install(plan.node!)).rejects.toThrow(AgentPlanStaleError);
  });

  it("body-only upstream change does NOT trigger PlanStaleError", async () => {
    fetcher.set("file:/abs/agent", { "AGENTS.md": ANCHOR("agent") });
    const plan = await svc.resolve("file:/abs/agent");
    fetcher.set("file:/abs/agent", {
      "AGENTS.md": ANCHOR("agent") + "\nNew body content.\n",
    });
    const a = await svc.install(plan.node!);
    expect(a.fqn).toBe("public/agent");
  });

  it("install fails when fetched tree has no AGENTS.md", async () => {
    fetcher.set("file:/abs/bad", { "AGENTS.md": ANCHOR("agent") });
    const plan = await svc.resolve("file:/abs/bad");
    fetcher.set("file:/abs/bad", { "other.md": "x" });
    await expect(svc.install(plan.node!)).rejects.toThrow(AgentFrontmatterError);
  });
});

// ─── single-entity API ────────────────────────────────────────

describe("AgentService — single-entity API", () => {
  beforeEach(async () => {
    fetcher.set("file:/abs/agent", { "AGENTS.md": ANCHOR("agent") });
    await svc.install("file:/abs/agent");
  });

  it("get returns Agent entity", async () => {
    const a = await svc.get("public/agent");
    expect(a).toBeInstanceOf(Agent);
    expect(a!.fqn).toBe("public/agent");
  });

  it("has returns true / false", async () => {
    expect(await svc.has("public/agent")).toBe(true);
    expect(await svc.has("public/missing")).toBe(false);
  });

  it("list returns all installed agents", async () => {
    fetcher.set("file:/abs/other", { "AGENTS.md": ANCHOR("other") });
    await svc.install("file:/abs/other");
    const all = await svc.list();
    expect(all.map((a) => a.fqn).sort()).toEqual(["public/agent", "public/other"]);
  });

  it("delete removes the agent", async () => {
    await svc.delete("public/agent");
    expect(await svc.has("public/agent")).toBe(false);
  });

  it("delete throws NotFound for missing agent", async () => {
    await expect(svc.delete("public/never")).rejects.toThrow(AgentNotFoundError);
  });

  it("updateAnchor preserves siblings + identity", async () => {
    fetcher.set("file:/abs/agent-with-sibling", {
      "AGENTS.md": ANCHOR("agent-with-sibling"),
      "extra.txt": "extra",
    });
    await svc.install("file:/abs/agent-with-sibling");

    const newMd = ANCHOR("agent-with-sibling").replace("description: x", "description: updated");
    const updated = await svc.updateAnchor("public/agent-with-sibling", newMd);
    expect(updated.description).toBe("updated");

    const files = new Map<string, Buffer>();
    for await (const f of svc.streamFiles("public/agent-with-sibling"))
      files.set(f.relPath, f.content);
    expect(files.get("extra.txt")?.toString("utf8")).toBe("extra");
  });

  it("updateAnchor rejects identity change", async () => {
    const renamed = ANCHOR("renamed");
    await expect(svc.updateAnchor("public/agent", renamed)).rejects.toThrow(
      /cannot change identity/,
    );
  });

  it("updateAnchor rejects writes on immutable (non-file:) origins", async () => {
    fetcher.set("github:o/r/tree/main/agents/upstream-only", {
      "AGENTS.md": ANCHOR("upstream-only"),
    });
    await svc.install("github:o/r/tree/main/agents/upstream-only");
    const newMd = ANCHOR("upstream-only").replace("description: x", "description: hacked");
    await expect(svc.updateAnchor("public/upstream-only", newMd)).rejects.toMatchObject({
      name: "ImmutableOriginError",
      fqn: "public/upstream-only",
      origin: "github:o/r/tree/main/agents/upstream-only",
    });
  });

  it("updateMetadata applies a partial patch and preserves body", async () => {
    fetcher.set("file:/abs/patchable", {
      "AGENTS.md": `---
name: patchable
description: original
version: 1.0.0
---
# Body kept verbatim

with multiple lines
`,
    });
    await svc.install("file:/abs/patchable");
    const updated = await svc.updateMetadata("public/patchable", {
      description: "new description",
      version: "1.1.0",
    });
    expect(updated.description).toBe("new description");
    expect(updated.version).toBe("1.1.0");
    expect(updated.anchorContent).toContain("# Body kept verbatim");
    expect(updated.anchorContent).toContain("with multiple lines");
  });

  it("updateMetadata rejects patches that try to change identity (name/scope/fqn)", async () => {
    for (const forbidden of ["name", "scope", "fqn"] as const) {
      await expect(
        svc.updateMetadata("public/agent", { [forbidden]: "evil" } as Record<string, unknown>),
      ).rejects.toMatchObject({
        name: "AgentFrontmatterError",
        message: expect.stringContaining(forbidden),
      });
    }
  });

  it("updateMetadata rejects writes on immutable (non-file:) origins", async () => {
    fetcher.set("github:o/r/tree/main/agents/upstream-meta", {
      "AGENTS.md": ANCHOR("upstream-meta"),
    });
    await svc.install("github:o/r/tree/main/agents/upstream-meta");
    await expect(
      svc.updateMetadata("public/upstream-meta", { description: "hacked" }),
    ).rejects.toMatchObject({
      name: "ImmutableOriginError",
      fqn: "public/upstream-meta",
    });
  });
});
