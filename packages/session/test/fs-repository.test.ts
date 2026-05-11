import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionCorruptedError } from "../src/errors.js";
import { FsSessionRepository } from "../src/index.js";

let sessionsDir: string;

beforeEach(async () => {
  sessionsDir = await mkdtemp(path.join(tmpdir(), "emploke-fs-sess-"));
});
afterEach(async () => {
  await rm(sessionsDir, { recursive: true, force: true });
});

const ID = "20260509-aabbccdd";
const sample = {
  runtime: "copilot",
  createdAt: "2026-05-09T01:00:00.000Z",
  runtimeSessionId: "abc",
};

const writeWire = async (id: string, value: object) => {
  const dir = path.join(sessionsDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "session.json"), JSON.stringify(value), "utf8");
};

describe("FsSessionRepository", () => {
  it("save + read round-trip", async () => {
    const repo = new FsSessionRepository({ sessionsDir });
    await mkdir(path.join(sessionsDir, ID), { recursive: true });
    await repo.save(ID, sample);
    const back = await repo.read(ID);
    expect(back).toEqual(sample);
    // On-disk shape carries schemaVersion (wire format detail).
    const raw = JSON.parse(await readFile(path.join(sessionsDir, ID, "session.json"), "utf8"));
    expect(raw.schemaVersion).toBe(2);
    expect(raw.runtime).toBe("copilot");
  });

  it("save + read round-trip preserves lastLaunchMode", async () => {
    const repo = new FsSessionRepository({ sessionsDir });
    await mkdir(path.join(sessionsDir, ID), { recursive: true });
    await repo.save(ID, { ...sample, lastLaunchMode: "remote" });
    const back = await repo.read(ID);
    expect(back).toEqual({ ...sample, lastLaunchMode: "remote" });
    const raw = JSON.parse(await readFile(path.join(sessionsDir, ID, "session.json"), "utf8"));
    expect(raw.lastLaunchMode).toBe("remote");
  });

  it("read accepts legacy schemaVersion 1 (no lastLaunchMode)", async () => {
    const repo = new FsSessionRepository({ sessionsDir });
    await writeWire(ID, { schemaVersion: 1, ...sample });
    const back = await repo.read(ID);
    expect(back).toEqual(sample);
    expect(back?.lastLaunchMode).toBeUndefined();
  });

  it("read rejects invalid lastLaunchMode value", async () => {
    const repo = new FsSessionRepository({ sessionsDir });
    await writeWire(ID, { schemaVersion: 2, ...sample, lastLaunchMode: "bogus" });
    await expect(repo.read(ID)).rejects.toMatchObject({
      constructor: SessionCorruptedError,
      reason: expect.stringContaining("lastLaunchMode"),
    });
  });

  it("read returns null for missing session.json", async () => {
    const repo = new FsSessionRepository({ sessionsDir });
    // Use a syntactically valid id that simply doesn't exist on disk —
    // FsSessionRepository now rejects malformed ids with InvalidSessionIdError.
    expect(await repo.read("20990101-deadbeef")).toBeNull();
  });

  it("read throws SessionCorruptedError on malformed JSON", async () => {
    const repo = new FsSessionRepository({ sessionsDir });
    const dir = path.join(sessionsDir, ID);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "session.json"), "not json", "utf8");
    await expect(repo.read(ID)).rejects.toBeInstanceOf(SessionCorruptedError);
  });

  it("read throws on newer schemaVersion (upgrade hint)", async () => {
    const repo = new FsSessionRepository({ sessionsDir });
    await writeWire(ID, { schemaVersion: 99, ...sample });
    await expect(repo.read(ID)).rejects.toMatchObject({
      constructor: SessionCorruptedError,
      reason: expect.stringContaining("Upgrade the server"),
    });
  });

  it("read throws on schemaVersion below the supported minimum", async () => {
    const repo = new FsSessionRepository({ sessionsDir });
    await writeWire(ID, { schemaVersion: 0, ...sample });
    await expect(repo.read(ID)).rejects.toMatchObject({
      constructor: SessionCorruptedError,
      reason: expect.stringContaining("never supported"),
    });
  });

  it("delete is idempotent for missing session", async () => {
    const repo = new FsSessionRepository({ sessionsDir });
    // Valid format id, just absent on disk. Malformed ids are rejected
    // up-front by InvalidSessionIdError.
    await repo.delete("20990101-cafebabe");
  });

  it("read/save/delete reject malformed ids with InvalidSessionIdError", async () => {
    const { InvalidSessionIdError } = await import("../src/errors.js");
    const repo = new FsSessionRepository({ sessionsDir });
    await expect(repo.read("../../etc/passwd")).rejects.toBeInstanceOf(InvalidSessionIdError);
    await expect(
      repo.save("../../etc", { runtime: "x", createdAt: "x", runtimeSessionId: null }),
    ).rejects.toBeInstanceOf(InvalidSessionIdError);
  });

  it("list returns matching ids paired with state, applying createdSince", async () => {
    const repo = new FsSessionRepository({ sessionsDir });
    await mkdir(path.join(sessionsDir, "20260101-aaaaaaaa"), { recursive: true });
    await repo.save("20260101-aaaaaaaa", { ...sample, createdAt: "2026-01-01T00:00:00.000Z" });
    await mkdir(path.join(sessionsDir, "20260601-bbbbbbbb"), { recursive: true });
    await repo.save("20260601-bbbbbbbb", { ...sample, createdAt: "2026-06-01T00:00:00.000Z" });

    const all = await repo.list();
    expect(all).toHaveLength(2);

    const since = await repo.list({ createdSince: "2026-03-01T00:00:00.000Z" });
    expect(since).toHaveLength(1);
    expect(since[0].id).toBe("20260601-bbbbbbbb");
  });

  it("list silently drops dirs whose session.json is corrupted", async () => {
    const repo = new FsSessionRepository({ sessionsDir });
    await mkdir(path.join(sessionsDir, "20260101-aaaaaaaa"), { recursive: true });
    await repo.save("20260101-aaaaaaaa", sample);
    await writeWire("20260101-bbbbbbbb", { schemaVersion: 99, ...sample });
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("20260101-aaaaaaaa");
  });
});
