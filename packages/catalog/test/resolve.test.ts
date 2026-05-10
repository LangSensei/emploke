import { mkdir, rm } from "node:fs/promises";
import { type EntryFile, type Fetcher, FetcherRegistry } from "@emploke/catalog-fetcher";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  catalogDir = makeBase("resolve-test");
  await mkdir(catalogDir, { recursive: true });
  fetchers = new FetcherRegistry();
  fetchers.register(new FakeFetcher("file"));
  fetchers.register(new FakeFetcher("github"));
  entries = new Map();
});

afterEach(async () => {
  await rm(catalogDir, { recursive: true, force: true });
});

describe("resolveInstall", () => {
  it("returns a single 'new' node for a leaf skill", async () => {
    const origin = "file:/test/leaf";
    entries.set(origin, [file("SKILL.md", "---\nname: leaf\ndescription: l\n---\n")]);
    const catalog = await CatalogManager.open({ catalogDir, fetchers });
    const m = await resolveInstall({
      catalog,
      rootKind: "skill",
      rootOrigin: origin,
    });
    expect(m.rootFqn).toBe("public/leaf");
    expect(m.nodes).toHaveLength(1);
    const n = m.nodes[0];
    if (!n || n.kind !== "skill") throw new Error("expected skill node");
    expect(n.fqn).toBe("public/leaf");
    expect(n.status).toBe("new");
    expect(n.scope).toBe("public");
    expect(n.scopeIsDefault).toBe(true);
  });

  it("walks transitive dependencies", async () => {
    const rootOrigin = "file:/test/parent";
    const childOrigin = "file:/test/child";
    entries.set(rootOrigin, [
      file(
        "SKILL.md",
        [
          "---",
          "name: parent",
          "description: p",
          "dependencies:",
          "  skills:",
          "    - { name: child, origin: file:/test/child }",
          "---",
        ].join("\n"),
      ),
    ]);
    entries.set(childOrigin, [file("SKILL.md", "---\nname: child\ndescription: c\n---\n")]);
    const catalog = await CatalogManager.open({ catalogDir, fetchers });
    const m = await resolveInstall({
      catalog,
      rootKind: "skill",
      rootOrigin,
    });
    const fqns = m.nodes.map((n) => n.fqn);
    expect(fqns).toContain("public/parent");
    expect(fqns).toContain("public/child");
  });

  it("flags a fetch failure as parse-failed/fetch-failed and continues siblings", async () => {
    const rootOrigin = "file:/test/parent";
    const goodChild = "file:/test/good";
    const badChild = "file:/test/bad";
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
    // badChild not registered → fetch fails
    const catalog = await CatalogManager.open({ catalogDir, fetchers });
    const m = await resolveInstall({
      catalog,
      rootKind: "skill",
      rootOrigin,
    });
    const good = m.nodes.find((n) => n.origin === goodChild);
    const bad = m.nodes.find((n) => n.origin === badChild);
    expect(good?.status).toBe("new");
    expect(bad?.status).toBe("fetch-failed");
    expect(bad?.error).toBeDefined();
  });

  it("MCP nodes are leaves (no further recursion)", async () => {
    const rootOrigin = "file:/test/parent";
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
    const catalog = await CatalogManager.open({ catalogDir, fetchers });
    const m = await resolveInstall({
      catalog,
      rootKind: "skill",
      rootOrigin,
    });
    const mcp = m.nodes.find((n) => n.kind === "mcp");
    if (!mcp || mcp.kind !== "mcp") throw new Error("expected mcp node");
    expect(mcp.fqn).toBe("ns/mcp");
    expect(mcp.specName).toBe("ns/mcp");
    expect(mcp.depFqns).toEqual([]);
    expect(mcp.status).toBe("new");
  });

  it("uses inline scope when frontmatter declares scope", async () => {
    const origin = "file:/test/x";
    entries.set(origin, [file("SKILL.md", "---\nname: x\nscope: my-fork\ndescription: x\n---\n")]);
    const catalog = await CatalogManager.open({ catalogDir, fetchers });
    const m = await resolveInstall({
      catalog,
      rootKind: "skill",
      rootOrigin: origin,
    });
    const n = m.nodes[0];
    if (!n || n.kind !== "skill") throw new Error("expected skill node");
    expect(n.scope).toBe("my-fork");
    expect(n.scopeIsDefault).toBe(false);
  });

  it("MCP root resolves directly without fetching", async () => {
    const origin = "https://github.com/Azure/azure-mcp/tree/main/.mcp/server.json";
    const catalog = await CatalogManager.open({ catalogDir, fetchers });
    const m = await resolveInstall({
      catalog,
      rootKind: "mcp",
      rootOrigin: origin,
      rootMcpName: "azure/mcp",
    });
    expect(m.rootFqn).toBe("azure/mcp");
    const n = m.nodes[0];
    if (!n || n.kind !== "mcp") throw new Error("expected mcp");
    expect(n.specName).toBe("azure/mcp");
    expect(n.status).toBe("new");
  });
});
