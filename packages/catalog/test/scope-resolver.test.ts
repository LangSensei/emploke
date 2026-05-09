import { describe, expect, it } from "vitest";
import { CATALOG_CONFIG_VERSION } from "../src/repositories/catalog-repository.js";
import { InMemoryCatalogRepository } from "../src/repositories/in-memory-catalog-repository.js";
import { ScopeResolver } from "../src/scope-resolver.js";

async function makeResolver(initial?: Record<string, string>): Promise<{
  resolver: ScopeResolver;
  repo: InMemoryCatalogRepository;
}> {
  const repo = new InMemoryCatalogRepository();
  if (initial) {
    await repo.write({ version: CATALOG_CONFIG_VERSION, scopeMappings: initial });
  }
  const resolver = await ScopeResolver.load(repo);
  return { resolver, repo };
}

describe("ScopeResolver — L3 default fallback", () => {
  it("github → owner.toLowerCase()", async () => {
    const { resolver } = await makeResolver();
    const r = await resolver.resolve("https://github.com/LangSensei/marketplace/tree/main/foo");
    expect(r.scope).toBe("langsensei");
    expect(r.source).toBe("L3");
    expect(r.matchedPattern).toBe("github.com/LangSensei/*");
  });

  it("file → local", async () => {
    const { resolver } = await makeResolver();
    const r = await resolver.resolve("file:/abs/path/skill");
    expect(r.scope).toBe("local");
    expect(r.source).toBe("L3");
  });

  it("L3 fallback auto-writes the mapping into L2", async () => {
    const { resolver, repo } = await makeResolver();
    await resolver.resolve("https://github.com/LangSensei/marketplace/tree/main/foo");
    const stored = await repo.read();
    expect(stored?.scopeMappings).toEqual({ "github.com/LangSensei/*": "langsensei" });
  });

  it("subsequent resolve from same publisher uses L2 (no re-derivation)", async () => {
    const { resolver } = await makeResolver();
    await resolver.resolve("https://github.com/LangSensei/marketplace/tree/main/foo");
    const r = await resolver.resolve("https://github.com/LangSensei/skills/tree/main/bar");
    expect(r.source).toBe("L2");
    expect(r.scope).toBe("langsensei");
    expect(r.matchedPattern).toBe("github.com/LangSensei/*");
  });
});

describe("ScopeResolver — L2 longest-match", () => {
  it("matches the longest pattern when multiple prefixes apply", async () => {
    const { resolver } = await makeResolver({
      "github.com/LangSensei/*": "langsensei",
      "github.com/LangSensei/marketplace/skills/travel/*": "travel",
    });
    const r = await resolver.resolve(
      "https://github.com/LangSensei/marketplace/tree/main/skills/travel/hotel",
    );
    expect(r.scope).toBe("travel");
    expect(r.matchedPattern).toBe("github.com/LangSensei/marketplace/skills/travel/*");
  });

  it("falls through to L3 when no L2 prefix matches", async () => {
    const { resolver } = await makeResolver({ "github.com/Other/*": "other" });
    const r = await resolver.resolve("https://github.com/LangSensei/marketplace/tree/main/foo");
    expect(r.source).toBe("L3");
    expect(r.scope).toBe("langsensei");
  });
});

describe("ScopeResolver — preview()", () => {
  it("does not auto-write to L2", async () => {
    const { resolver, repo } = await makeResolver();
    resolver.preview("https://github.com/LangSensei/marketplace/tree/main/foo");
    expect(await repo.read()).toBeNull();
  });

  it("returns the same scope as resolve() would", async () => {
    const { resolver } = await makeResolver({ "github.com/LangSensei/*": "ls" });
    const previewed = resolver.preview("https://github.com/LangSensei/x/tree/main/y");
    expect(previewed.scope).toBe("ls");
    expect(previewed.source).toBe("L2");
  });
});

describe("ScopeResolver — upsertMapping()", () => {
  it("inserts a new mapping and refreshes the snapshot", async () => {
    const { resolver, repo } = await makeResolver();
    await resolver.upsertMapping("github.com/Anthropic/*", "anthropic");
    const r = resolver.preview("https://github.com/Anthropic/skills/tree/main/x");
    expect(r.source).toBe("L2");
    expect(r.scope).toBe("anthropic");
    const stored = await repo.read();
    expect(stored?.scopeMappings).toEqual({ "github.com/Anthropic/*": "anthropic" });
  });

  it("overwrites an existing mapping", async () => {
    const { resolver } = await makeResolver({ "github.com/Anthropic/*": "old" });
    await resolver.upsertMapping("github.com/Anthropic/*", "anthropic");
    expect(resolver.mappings()["github.com/Anthropic/*"]).toBe("anthropic");
  });
});
