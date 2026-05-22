import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EntryFile } from "../../src/fetcher/index.js";
import {
  PlanStaleError,
  SkillFrontmatterError,
  SkillNotFoundError,
  SkillOriginConflictError,
} from "../../src/skill/errors.js";
import { SkillEntity } from "../../src/skill/skill-entity.js";
import { SkillRepository } from "../../src/skill/skill-repository.js";
import { type SkillFetcher, SkillService } from "../../src/skill/skill-service.js";
import { bootstrapCatalogDb } from "../helpers/bootstrap.js";

function makeFetcher(): {
  fetcher: SkillFetcher;
  set: (origin: string, files: Record<string, string>) => void;
} {
  const trees = new Map<string, Map<string, Buffer>>();
  const fetcher: SkillFetcher = {
    async fetchAnchor(origin) {
      const tree = trees.get(origin);
      if (tree === undefined) throw new Error(`fake fetcher: no fixture for ${origin}`);
      const anchor = tree.get("SKILL.md");
      if (anchor === undefined) throw new Error(`fake fetcher: no SKILL.md for ${origin}`);
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

let orm: ReturnType<typeof openTestCatalogDb>;
let repo: SkillRepository;
let fetcher: ReturnType<typeof makeFetcher>;
let svc: SkillService;

beforeEach(async () => {
  orm = bootstrapCatalogDb();

  repo = new SkillRepository({ db: orm.db });
  fetcher = makeFetcher();
  svc = new SkillService(repo, fetcher.fetcher);
});

afterEach(async () => {
  try {
    orm.close();
  } catch {
    // already closed
  }
});

// ─── resolve ──────────────────────────────────────────────────

describe("SkillService.resolve", () => {
  it("returns a single-node plan for a leaf skill", async () => {
    fetcher.set("file:/abs/tool", { "SKILL.md": ANCHOR("tool") });
    const plan = await svc.resolve("file:/abs/tool");
    expect(plan.conflict).toBeNull();
    expect(plan.node).not.toBeNull();
    expect(plan.node!.fqn).toBe("public/tool");
    expect(plan.node!.depsRefs.skills).toEqual([]);
    expect(plan.node!.depsRefs.mcps).toEqual([]);
  });

  it("captures the upstream version on the resolved node", async () => {
    fetcher.set("file:/abs/tool", { "SKILL.md": ANCHOR("tool") });
    const plan = await svc.resolve("file:/abs/tool");
    expect(plan.node!.version).toBe("1.0.0");
  });

  it("surfaces dep refs (does NOT recurse — facade's job)", async () => {
    const deps = `dependencies:
  skills:
    - "file:/abs/skills/web-search"
  mcps:
    - "file:/abs/mcps/azure"`;
    fetcher.set("file:/abs/tool", { "SKILL.md": ANCHOR("tool", deps) });
    const plan = await svc.resolve("file:/abs/tool");
    expect(plan.node!.depsRefs.skills).toEqual(["file:/abs/skills/web-search"]);
    expect(plan.node!.depsRefs.mcps).toEqual(["file:/abs/mcps/azure"]);
  });

  it("resolve only fetches the anchor — not sibling files", async () => {
    fetcher.set("file:/abs/tool", {
      "SKILL.md": ANCHOR("tool"),
      "siblings-shouldnt-be-touched.txt": "x",
    });
    // resolve only calls fetchAnchor; siblings are never read here.
    // (We don't have an introspection hook on the fake fetcher, so
    // we settle for "resolve succeeded with the right node shape".)
    const plan = await svc.resolve("file:/abs/tool");
    expect(plan.node!.fqn).toBe("public/tool");
    expect(plan.node!.anchorContent).toBe(ANCHOR("tool"));
  });

  it("surfaces fetch failures as conflict", async () => {
    const plan = await svc.resolve("file:/abs/never");
    expect(plan.node).toBeNull();
    expect(plan.conflict?.reason.kind).toBe("fetch-failed");
  });

  it("surfaces parse failures as conflict", async () => {
    fetcher.set("file:/abs/bad", { "SKILL.md": "no frontmatter" });
    const plan = await svc.resolve("file:/abs/bad");
    expect(plan.node).toBeNull();
    expect(plan.conflict?.reason.kind).toBe("parse-failed");
  });

  it("surfaces FQN-different-origin as conflict", async () => {
    fetcher.set("file:/abs/a", { "SKILL.md": ANCHOR("tool") });
    await svc.install("file:/abs/a");

    fetcher.set("file:/abs/b", { "SKILL.md": ANCHOR("tool") });
    const plan = await svc.resolve("file:/abs/b");
    expect(plan.conflict?.reason.kind).toBe("origin-conflict");
  });
});

// ─── install ──────────────────────────────────────────────────

describe("SkillService.install", () => {
  it("installs from origin string (resolve + install)", async () => {
    fetcher.set("file:/abs/tool", { "SKILL.md": ANCHOR("tool"), "extra.txt": "extra" });
    const s = await svc.install("file:/abs/tool");
    expect(s.fqn).toBe("public/tool");
    const got = await svc.get("public/tool");
    expect(got).not.toBeNull();
    const files = new Map<string, Buffer>();
    for await (const f of svc.streamFiles("public/tool")) files.set(f.relPath, f.content);
    expect(files.get("extra.txt")?.toString("utf8")).toBe("extra");
  });

  it("installs from a resolved plan node", async () => {
    fetcher.set("file:/abs/tool", { "SKILL.md": ANCHOR("tool") });
    const plan = await svc.resolve("file:/abs/tool");
    expect(plan.node).not.toBeNull();
    const s = await svc.install(plan.node!);
    expect(s.fqn).toBe("public/tool");
  });

  it("does NOT install dep skills / mcps (facade's job)", async () => {
    const deps = `dependencies:
  skills:
    - "file:/abs/child"`;
    fetcher.set("file:/abs/parent", { "SKILL.md": ANCHOR("parent", deps) });
    // Note: we do NOT register a fixture for file:./child — proving
    // the service never tries to fetch it.
    const s = await svc.install("file:/abs/parent");
    expect(s.fqn).toBe("public/parent");
    expect(await svc.has("public/child")).toBe(false);
  });

  it("upserts content under same origin", async () => {
    fetcher.set("file:/abs/tool", { "SKILL.md": ANCHOR("tool"), "data.txt": "v1" });
    await svc.install("file:/abs/tool");
    fetcher.set("file:/abs/tool", { "SKILL.md": ANCHOR("tool"), "data.txt": "v2" });
    await svc.install("file:/abs/tool");
    const files = new Map<string, Buffer>();
    for await (const f of svc.streamFiles("public/tool")) files.set(f.relPath, f.content);
    expect(files.get("data.txt")?.toString("utf8")).toBe("v2");
  });

  it("rejects same-FQN reinstall from different origin", async () => {
    fetcher.set("file:/abs/a", { "SKILL.md": ANCHOR("tool") });
    await svc.install("file:/abs/a");
    fetcher.set("file:/abs/b", { "SKILL.md": ANCHOR("tool") });
    await expect(svc.install("file:/abs/b")).rejects.toThrow(SkillOriginConflictError);
  });

  it("throws PlanStaleError when version changes between resolve and install", async () => {
    fetcher.set("file:/abs/tool", { "SKILL.md": ANCHOR("tool") });
    const plan = await svc.resolve("file:/abs/tool");
    fetcher.set("file:/abs/tool", { "SKILL.md": ANCHOR("tool").replace("1.0.0", "2.0.0") });
    await expect(svc.install(plan.node!)).rejects.toThrow(PlanStaleError);
  });

  it("body-only upstream change does NOT trigger PlanStaleError (author contract)", async () => {
    fetcher.set("file:/abs/tool", { "SKILL.md": ANCHOR("tool") });
    const plan = await svc.resolve("file:/abs/tool");
    fetcher.set("file:/abs/tool", { "SKILL.md": `${ANCHOR("tool")}\nNew body content.\n` });
    const s = await svc.install(plan.node!);
    expect(s.fqn).toBe("public/tool");
  });

  it("frontmatter-edit-without-version-bump does NOT trigger PlanStaleError (author contract)", async () => {
    // Per the version-as-truth contract, even a frontmatter edit
    // (e.g. tweaking description) without a version bump is a
    // contributor bug — emploke treats it as a no-op rather than
    // racing on it.
    fetcher.set("file:/abs/tool", { "SKILL.md": ANCHOR("tool") });
    const plan = await svc.resolve("file:/abs/tool");
    const tweaked = ANCHOR("tool").replace("description: x", "description: tweaked");
    fetcher.set("file:/abs/tool", { "SKILL.md": tweaked });
    const s = await svc.install(plan.node!);
    expect(s.fqn).toBe("public/tool");
    // The installed entity carries the freshly-fetched description —
    // the staleness check is the only gate, not a "reject if anything
    // changed" check.
    expect(s.description).toBe("tweaked");
  });

  it("install fails when fetched tree has no SKILL.md", async () => {
    fetcher.set("file:/abs/bad", { "SKILL.md": ANCHOR("tool") });
    const plan = await svc.resolve("file:/abs/bad");
    fetcher.set("file:/abs/bad", { "other.md": "x" });
    await expect(svc.install(plan.node!)).rejects.toThrow(SkillFrontmatterError);
  });
});

// ─── single-entity API ────────────────────────────────────────

describe("SkillService — single-entity API", () => {
  beforeEach(async () => {
    fetcher.set("file:/abs/tool", { "SKILL.md": ANCHOR("tool") });
    await svc.install("file:/abs/tool");
  });

  it("get returns SkillEntity entity", async () => {
    const s = await svc.get("public/tool");
    expect(s).toBeInstanceOf(SkillEntity);
    expect(s!.fqn).toBe("public/tool");
  });

  it("getByOrigin returns the entity matching origin", async () => {
    const s = await svc.getByOrigin("file:/abs/tool");
    expect(s!.fqn).toBe("public/tool");
  });

  it("has returns true / false", async () => {
    expect(await svc.has("public/tool")).toBe(true);
    expect(await svc.has("public/missing")).toBe(false);
  });

  it("list returns all installed skills", async () => {
    fetcher.set("file:/abs/other", { "SKILL.md": ANCHOR("other") });
    await svc.install("file:/abs/other");
    const all = await svc.list();
    expect(all.map((s) => s.fqn).sort()).toEqual(["public/other", "public/tool"]);
  });

  it("delete removes the skill", async () => {
    await svc.delete("public/tool");
    expect(await svc.has("public/tool")).toBe(false);
  });

  it("delete throws NotFound for missing skill", async () => {
    await expect(svc.delete("public/never")).rejects.toThrow(SkillNotFoundError);
  });

  it("updateAnchor preserves siblings + identity", async () => {
    fetcher.set("file:/abs/tool-with-sibling", {
      "SKILL.md": ANCHOR("tool-with-sibling"),
      "extra.txt": "extra",
    });
    await svc.install("file:/abs/tool-with-sibling");

    const newMd = ANCHOR("tool-with-sibling").replace("description: x", "description: updated");
    const updated = await svc.updateAnchor("public/tool-with-sibling", newMd);
    expect(updated.description).toBe("updated");

    const files = new Map<string, Buffer>();
    for await (const f of svc.streamFiles("public/tool-with-sibling"))
      files.set(f.relPath, f.content);
    expect(files.get("extra.txt")?.toString("utf8")).toBe("extra");
  });

  it("updateAnchor rejects identity change", async () => {
    const renamed = ANCHOR("renamed");
    await expect(svc.updateAnchor("public/tool", renamed)).rejects.toThrow(
      /cannot change identity/,
    );
  });

  it("updateAnchor rejects writes on immutable (non-file:) origins", async () => {
    fetcher.set("github:o/r/tree/main/skills/upstream-only", {
      "SKILL.md": ANCHOR("upstream-only"),
    });
    await svc.install("github:o/r/tree/main/skills/upstream-only");
    const newMd = ANCHOR("upstream-only").replace("description: x", "description: hacked");
    await expect(svc.updateAnchor("public/upstream-only", newMd)).rejects.toMatchObject({
      name: "ImmutableOriginError",
      fqn: "public/upstream-only",
      origin: "github:o/r/tree/main/skills/upstream-only",
    });
  });

  it("updateMetadata applies a partial patch and preserves body", async () => {
    fetcher.set("file:/abs/patchable", {
      "SKILL.md": `---
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
    const anchor = await svc.getAnchor("public/patchable");
    expect(anchor).toContain("# Body kept verbatim");
    expect(anchor).toContain("with multiple lines");
  });

  it("updateMetadata rejects patches that try to change identity (name/scope/fqn)", async () => {
    for (const forbidden of ["name", "scope", "fqn"] as const) {
      await expect(
        svc.updateMetadata("public/tool", { [forbidden]: "evil" } as Record<string, unknown>),
      ).rejects.toMatchObject({
        name: "SkillFrontmatterError",
        message: expect.stringContaining(forbidden),
      });
    }
  });

  it("updateMetadata rejects writes on immutable (non-file:) origins", async () => {
    fetcher.set("github:o/r/tree/main/skills/upstream-meta", {
      "SKILL.md": ANCHOR("upstream-meta"),
    });
    await svc.install("github:o/r/tree/main/skills/upstream-meta");
    await expect(
      svc.updateMetadata("public/upstream-meta", { description: "hacked" }),
    ).rejects.toMatchObject({
      name: "ImmutableOriginError",
      fqn: "public/upstream-meta",
    });
  });
});
