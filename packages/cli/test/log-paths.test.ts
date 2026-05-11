import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveLatestLog } from "../src/log-paths.js";

describe("log-paths.resolveLatestLog", () => {
  let home: string;
  let logsDir: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "emploke-cli-lp-"));
    logsDir = path.join(home, "logs");
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("returns null when the logs dir is absent", async () => {
    expect(await resolveLatestLog(logsDir)).toBeNull();
  });

  it("returns null when the logs dir is empty", async () => {
    await mkdir(logsDir, { recursive: true });
    expect(await resolveLatestLog(logsDir)).toBeNull();
  });

  it("ignores files that do not match the basename prefix", async () => {
    await mkdir(logsDir, { recursive: true });
    await writeFile(path.join(logsDir, "other.log"), "x");
    await writeFile(path.join(logsDir, "README.md"), "x");
    expect(await resolveLatestLog(logsDir)).toBeNull();
  });

  it("returns the bare-basename file when it is the only match", async () => {
    await mkdir(logsDir, { recursive: true });
    const f = path.join(logsDir, "server");
    await writeFile(f, "first");
    expect(await resolveLatestLog(logsDir)).toBe(f);
  });

  it("picks the newest file across pino-roll suffixes", async () => {
    await mkdir(logsDir, { recursive: true });
    const old = path.join(logsDir, "server.2026-05-08");
    const newer = path.join(logsDir, "server.2026-05-09");
    const newest = path.join(logsDir, "server.2026-05-10");
    await writeFile(old, "older");
    await writeFile(newer, "older");
    await writeFile(newest, "older");
    const baseTs = Date.now() / 1000;
    await utimes(old, baseTs - 200, baseTs - 200);
    await utimes(newer, baseTs - 100, baseTs - 100);
    await utimes(newest, baseTs, baseTs);
    expect(await resolveLatestLog(logsDir)).toBe(newest);
  });

  it("respects an explicit basename override", async () => {
    await mkdir(logsDir, { recursive: true });
    await writeFile(path.join(logsDir, "server"), "x");
    const ours = path.join(logsDir, "audit");
    await writeFile(ours, "y");
    expect(await resolveLatestLog(logsDir, "audit")).toBe(ours);
  });
});
