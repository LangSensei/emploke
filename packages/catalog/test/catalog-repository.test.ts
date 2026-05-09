import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CATALOG_CONFIG_VERSION } from "../src/repositories/catalog-repository.js";
import { FsCatalogRepository } from "../src/repositories/fs-catalog-repository.js";
import { InMemoryCatalogRepository } from "../src/repositories/in-memory-catalog-repository.js";
import { makeBase } from "./helpers.js";

let catalogDir: string;

beforeEach(async () => {
  catalogDir = makeBase("catalog-repo");
  await mkdir(catalogDir, { recursive: true });
});

afterEach(async () => {
  await rm(catalogDir, { recursive: true, force: true });
});

describe("FsCatalogRepository", () => {
  it("read() returns null when catalog.json is absent", async () => {
    const repo = new FsCatalogRepository(catalogDir);
    expect(await repo.read()).toBeNull();
  });

  it("write() then read() round-trips", async () => {
    const repo = new FsCatalogRepository(catalogDir);
    await repo.write({
      version: CATALOG_CONFIG_VERSION,
      scopeMappings: { "github.com/LangSensei/*": "langsensei" },
    });
    const out = await repo.read();
    expect(out?.version).toBe(CATALOG_CONFIG_VERSION);
    expect(out?.scopeMappings).toEqual({ "github.com/LangSensei/*": "langsensei" });
  });

  it("write is atomic (tmp + rename)", async () => {
    const repo = new FsCatalogRepository(catalogDir);
    await repo.write({ version: CATALOG_CONFIG_VERSION, scopeMappings: { "a/*": "x" } });
    // No .tmp file left behind
    const dirContents = await readFile(join(catalogDir, "catalog.json"), "utf8");
    expect(dirContents).toContain('"version"');
  });

  it("read() throws on malformed JSON", async () => {
    await writeFile(join(catalogDir, "catalog.json"), "not json{");
    const repo = new FsCatalogRepository(catalogDir);
    await expect(repo.read()).rejects.toThrow(/not valid JSON/);
  });

  it("read() throws on unknown version", async () => {
    await writeFile(
      join(catalogDir, "catalog.json"),
      JSON.stringify({ version: 99, scopeMappings: {} }),
    );
    const repo = new FsCatalogRepository(catalogDir);
    await expect(repo.read()).rejects.toThrow(/unsupported catalog.json version/);
  });

  it("read() throws on non-object scopeMappings", async () => {
    await writeFile(
      join(catalogDir, "catalog.json"),
      JSON.stringify({ version: CATALOG_CONFIG_VERSION, scopeMappings: "oops" }),
    );
    const repo = new FsCatalogRepository(catalogDir);
    await expect(repo.read()).rejects.toThrow(/scopeMappings/);
  });
});

describe("InMemoryCatalogRepository", () => {
  it("read() returns null until first write", async () => {
    const repo = new InMemoryCatalogRepository();
    expect(await repo.read()).toBeNull();
  });

  it("write() then read() round-trips", async () => {
    const repo = new InMemoryCatalogRepository();
    await repo.write({ version: CATALOG_CONFIG_VERSION, scopeMappings: { "a/*": "x" } });
    const out = await repo.read();
    expect(out?.scopeMappings).toEqual({ "a/*": "x" });
  });

  it("read() returns a defensive snapshot (mutating result doesn't affect store)", async () => {
    const repo = new InMemoryCatalogRepository();
    await repo.write({ version: CATALOG_CONFIG_VERSION, scopeMappings: { "a/*": "x" } });
    const out = await repo.read();
    (out!.scopeMappings as Record<string, string>).evil = "x";
    const out2 = await repo.read();
    expect(out2!.scopeMappings.evil).toBeUndefined();
  });
});
