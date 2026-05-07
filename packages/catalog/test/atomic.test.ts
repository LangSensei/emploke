import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicReplaceDir, pathExists } from "../src/atomic.js";

describe("atomicReplaceDir", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "emploke-atomic-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("copies a fresh dir into place", async () => {
    const src = join(workDir, "src");
    const dst = join(workDir, "dst");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "file.txt"), "hello", "utf8");

    await atomicReplaceDir(src, dst);

    expect(await pathExists(dst)).toBe(true);
    expect(await readFile(join(dst, "file.txt"), "utf8")).toBe("hello");
  });

  it("replaces an existing dir", async () => {
    const src = join(workDir, "src");
    const dst = join(workDir, "dst");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "new.txt"), "new content", "utf8");
    await mkdir(dst, { recursive: true });
    await writeFile(join(dst, "old.txt"), "old content", "utf8");

    await atomicReplaceDir(src, dst);

    expect(await pathExists(join(dst, "new.txt"))).toBe(true);
    expect(await pathExists(join(dst, "old.txt"))).toBe(false);
  });

  it("preserves nested files", async () => {
    const src = join(workDir, "src");
    const dst = join(workDir, "dst");
    await mkdir(join(src, "sub"), { recursive: true });
    await writeFile(join(src, "sub", "nested.txt"), "n", "utf8");

    await atomicReplaceDir(src, dst);

    expect(await readFile(join(dst, "sub", "nested.txt"), "utf8")).toBe("n");
  });

  it("creates parent directories if missing", async () => {
    const src = join(workDir, "src");
    const dst = join(workDir, "deep", "nested", "dst");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "x.txt"), "x", "utf8");

    await atomicReplaceDir(src, dst);

    expect(await pathExists(dst)).toBe(true);
  });

  it("leaves no .tmp.* siblings on success", async () => {
    const src = join(workDir, "src");
    const dst = join(workDir, "dst");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "file.txt"), "x", "utf8");

    await atomicReplaceDir(src, dst);

    const { readdir } = await import("node:fs/promises");
    const siblings = await readdir(workDir);
    expect(siblings.filter((n) => n.startsWith(".dst.tmp."))).toHaveLength(0);
    expect(siblings.filter((n) => n.startsWith(".dst.old."))).toHaveLength(0);
  });
});

describe("pathExists", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "emploke-exists-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("returns true for existing file", async () => {
    const f = join(workDir, "x");
    await writeFile(f, "", "utf8");
    expect(await pathExists(f)).toBe(true);
  });

  it("returns true for existing dir", async () => {
    expect(await pathExists(workDir)).toBe(true);
  });

  it("returns false for missing path", async () => {
    expect(await pathExists(join(workDir, "ghost"))).toBe(false);
  });
});
