import { mkdir, rm } from "node:fs/promises";
import { type EntryFile, type Fetcher, FetcherRegistry } from "@emploke/catalog-fetcher";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyInstall } from "../src/apply.js";
import { CatalogManager } from "../src/manager.js";
import { resolveInstall } from "../src/resolve.js";
import { makeBase } from "./helpers.js";

let catalogDir: string;
let fetchers: FetcherRegistry;
let entries: Map<string, EntryFile[]>;

class FakeFetcher implements Fetcher {
  constructor(public readonly scheme: string) {}
  async *fetch(uri: string): AsyncIterable<EntryFile> {
    const e = entries.get(uri);
    if (!e) throw Object.assign(new Error(`no fixture for ${uri}`), { name: "FetchError" });
    for (const f of e) yield f;
  }
}

function file(relPath: string, body: string): EntryFile {
  return { relPath, content: Buffer.from(body, "utf8") };
}

beforeEach(async () => {
  catalogDir = makeBase("apply-test");
  await mkdir(catalogDir, { recursive: true });
  fetchers = new FetcherRegistry();
  fetchers.register(new FakeFetcher("file"));
  fetchers.register(new FakeFetcher("github"));
  entries = new Map();
});

afterEach(async () => {
  await rm(catalogDir, { recursive: true, force: true });
});

describe("applyInstall", () => {
  it("installs a single skill node", async () => {
    const origin = "file:/test/leaf";
    entries.set(origin, [file("SKILL.md", "---\nname: leaf\ndescription: l\n---\n")]);
    const catalog = await CatalogManager.open({ catalogDir, fetchers });
    const manifest = await resolveInstall({
      catalog,
      rootKind: "skill",
      rootOrigin: origin,
    });
    const result = await applyInstall({ catalog, fetchers, manifest });
    expect(result.installed).toEqual([
      expect.objectContaining({ fqn: "public/leaf", kind: "skill", origin }),
    ]);
    expect(result.failed).toEqual([]);
    expect(catalog.getSkill("public/leaf")).toBeDefined();
  });

  it("respects inline `scope:` in frontmatter (no per-install override)", async () => {
    const origin = "https://github.com/Anthropic/skills/tree/main/leaf";
    entries.set(origin, [
      file("SKILL.md", "---\nname: leaf\nscope: anthropic\ndescription: l\n---\n"),
    ]);
    const catalog = await CatalogManager.open({ catalogDir, fetchers });
    const manifest = await resolveInstall({
      catalog,
      rootKind: "skill",
      rootOrigin: origin,
    });
    const result = await applyInstall({ catalog, fetchers, manifest });
    expect(result.installed).toEqual([expect.objectContaining({ fqn: "anthropic/leaf" })]);
    expect(catalog.getSkill("anthropic/leaf")).toBeDefined();
  });

  it("installs MCP leaf via standalone primitive (with _meta)", async () => {
    const rootOrigin = "file:/test/parent";
    const mcpOrigin = "file:/test/mcps/ns_mcp.json";
    entries.set(rootOrigin, [
      file(
        "SKILL.md",
        [
          "---",
          "name: parent",
          "description: p",
          "dependencies:",
          "  mcps:",
          "    - { name: ns/mcp, origin: file:/test/mcps/ns_mcp.json }",
          "---",
        ].join("\n"),
      ),
    ]);
    entries.set(mcpOrigin, [file("ns_mcp.json", JSON.stringify({ command: "x" }))]);
    const catalog = await CatalogManager.open({ catalogDir, fetchers });
    const manifest = await resolveInstall({
      catalog,
      rootKind: "skill",
      rootOrigin,
    });
    const result = await applyInstall({ catalog, fetchers, manifest });
    expect(result.failed).toEqual([]);
    expect(catalog.getMcp("ns/mcp")).toBeDefined();
    expect(catalog.getMcp("ns/mcp")?.origin).toBe(mcpOrigin);
  });

  it("skips already-installed nodes (same origin)", async () => {
    const origin = "file:/test/leaf";
    entries.set(origin, [file("SKILL.md", "---\nname: leaf\ndescription: l\n---\n")]);
    const catalog = await CatalogManager.open({ catalogDir, fetchers });
    // First install lands the entry.
    const m1 = await resolveInstall({
      catalog,
      rootKind: "skill",
      rootOrigin: origin,
    });
    await applyInstall({ catalog, fetchers, manifest: m1 });
    // Re-resolve and apply.
    const m2 = await resolveInstall({
      catalog,
      rootKind: "skill",
      rootOrigin: origin,
    });
    expect(m2.nodes[0]?.status).toBe("already-installed");
    const result = await applyInstall({ catalog, fetchers, manifest: m2 });
    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ fqn: "public/leaf", reason: "already-installed-same-origin" }),
    ]);
  });

  it("collects per-node failures rather than aborting", async () => {
    const rootOrigin = "file:/test/parent";
    const goodChild = "file:/test/good";
    entries.set(rootOrigin, [
      file(
        "SKILL.md",
        [
          "---",
          "name: parent",
          "description: p",
          "dependencies:",
          "  skills:",
          "    - { name: good, origin: file:/test/good }",
          "    - { name: bad, origin: file:/test/bad }",
          "---",
        ].join("\n"),
      ),
    ]);
    entries.set(goodChild, [file("SKILL.md", "---\nname: good\ndescription: g\n---\n")]);
    // bad → fetch fails (registered → no fixture)
    const catalog = await CatalogManager.open({ catalogDir, fetchers });
    const manifest = await resolveInstall({
      catalog,
      rootKind: "skill",
      rootOrigin,
    });
    const result = await applyInstall({ catalog, fetchers, manifest });
    // good + parent installed; bad skipped (resolution flagged it failed)
    expect(result.installed.map((e) => e.fqn).sort()).toEqual(["public/good", "public/parent"]);
    expect(result.skipped.some((s) => s.reason === "previewed-but-failed")).toBe(true);
  });
});
