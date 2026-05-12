import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidSessionIdError } from "../src/errors.js";
import { SqliteSessionRepository } from "../src/index.js";

let scratchDir: string;
let repo: SqliteSessionRepository;

beforeEach(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "emploke-sqlite-sess-"));
  // Use file-backed DB so we can also exercise the on-disk side
  // (parent-dir creation, second-open-survives, ...). Tests that only
  // need an isolated repo would be equally happy with `:memory:`.
  repo = new SqliteSessionRepository(path.join(scratchDir, "sessions.db"));
});
afterEach(async () => {
  repo.close();
  await rm(scratchDir, { recursive: true, force: true });
});

const ID = "20260509-aabbccdd";
const sample = {
  runtime: "copilot",
  createdAt: "2026-05-09T01:00:00.000Z",
  runtimeSessionId: "abc",
};

describe("SqliteSessionRepository", () => {
  it("save + read round-trip", async () => {
    await repo.save(ID, sample);
    const back = await repo.read(ID);
    expect(back).toEqual(sample);
  });

  it("save + read round-trip preserves lastLaunchMode", async () => {
    await repo.save(ID, { ...sample, lastLaunchMode: "remote" });
    const back = await repo.read(ID);
    expect(back).toEqual({ ...sample, lastLaunchMode: "remote" });
  });

  it("save is idempotent (INSERT OR REPLACE)", async () => {
    await repo.save(ID, sample);
    await repo.save(ID, { ...sample, runtimeSessionId: "updated" });
    const back = await repo.read(ID);
    expect(back?.runtimeSessionId).toBe("updated");
  });

  it("patchLastLaunchMode updates only the column, leaves other fields untouched", async () => {
    await repo.save(ID, sample);
    await repo.patchLastLaunchMode(ID, "remote");
    const back = await repo.read(ID);
    // runtime / createdAt / runtimeSessionId all preserved verbatim.
    expect(back).toEqual({ ...sample, lastLaunchMode: "remote" });
  });

  it("patchLastLaunchMode overwrites a previous mode (last writer wins)", async () => {
    await repo.save(ID, { ...sample, lastLaunchMode: "local" });
    await repo.patchLastLaunchMode(ID, "remote");
    expect((await repo.read(ID))?.lastLaunchMode).toBe("remote");
  });

  it("patchLastLaunchMode is a silent no-op when the row doesn't exist", async () => {
    await repo.patchLastLaunchMode(ID, "remote");
    expect(await repo.read(ID)).toBeNull();
  });

  it("patchLastLaunchMode rejects malformed ids", async () => {
    await expect(repo.patchLastLaunchMode("../../etc/passwd", "remote")).rejects.toBeInstanceOf(
      InvalidSessionIdError,
    );
  });

  it("patchLastLaunchMode does not race against a concurrent save of other fields", async () => {
    // Models the original #56 race shape, in miniature: a `save` and a
    // mode-patch fired against the same id at the same tick. With the
    // old `buildLaunch` code (read → save({...prev, lastLaunchMode}))
    // the save's `runtime_session_id` write would be silently lost if
    // the patch ran second. With `patchLastLaunchMode` the column
    // update is field-scoped, so both writes survive regardless of
    // which lands first.
    await repo.save(ID, sample);
    await Promise.all([
      repo.save(ID, { ...sample, runtimeSessionId: "from-refresh" }),
      repo.patchLastLaunchMode(ID, "remote"),
    ]);
    const back = await repo.read(ID);
    expect(back?.runtimeSessionId).toBe("from-refresh");
    expect(back?.lastLaunchMode).toBe("remote");
  });

  it("save preserves runtimeSessionId === null", async () => {
    await repo.save(ID, { ...sample, runtimeSessionId: null });
    const back = await repo.read(ID);
    expect(back?.runtimeSessionId).toBeNull();
  });

  it("read returns null for missing id", async () => {
    expect(await repo.read("20990101-deadbeef")).toBeNull();
  });

  it("delete removes the row; subsequent read returns null", async () => {
    await repo.save(ID, sample);
    await repo.delete(ID);
    expect(await repo.read(ID)).toBeNull();
  });

  it("delete is idempotent for missing id", async () => {
    await repo.delete("20990101-cafebabe");
  });

  it("read/save reject malformed ids with InvalidSessionIdError", async () => {
    await expect(repo.read("../../etc/passwd")).rejects.toBeInstanceOf(InvalidSessionIdError);
    await expect(
      repo.save("../../etc", { runtime: "x", createdAt: "x", runtimeSessionId: null }),
    ).rejects.toBeInstanceOf(InvalidSessionIdError);
  });

  it("delete with malformed id is a silent no-op (matches FS behaviour)", async () => {
    await repo.save(ID, sample);
    await repo.delete("../../etc/passwd");
    // Original row untouched.
    expect(await repo.read(ID)).toEqual(sample);
  });

  it("list returns all rows when no filter", async () => {
    await repo.save("20260101-aaaaaaaa", { ...sample, createdAt: "2026-01-01T00:00:00.000Z" });
    await repo.save("20260601-bbbbbbbb", { ...sample, createdAt: "2026-06-01T00:00:00.000Z" });
    const all = await repo.list();
    expect(all.map((e) => e.id).sort()).toEqual(["20260101-aaaaaaaa", "20260601-bbbbbbbb"]);
  });

  it("list applies createdSince filter (>=, ISO 8601 lex sort)", async () => {
    await repo.save("20260101-aaaaaaaa", { ...sample, createdAt: "2026-01-01T00:00:00.000Z" });
    await repo.save("20260601-bbbbbbbb", { ...sample, createdAt: "2026-06-01T00:00:00.000Z" });
    const since = await repo.list({ createdSince: "2026-03-01T00:00:00.000Z" });
    expect(since).toHaveLength(1);
    expect(since[0]?.id).toBe("20260601-bbbbbbbb");
  });

  it("rejects opening a sessions.db with an unknown future schema version", async () => {
    repo.close();
    // Use a fresh dbPath, open as a SqliteSessionRepository to set up
    // schema, then forge a newer version row directly via a sibling
    // raw connection.
    const dbPath = path.join(scratchDir, "future.db");
    const r = new SqliteSessionRepository(dbPath);
    r.close();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("UPDATE schema_meta SET version = 999");
    raw.close();
    expect(() => new SqliteSessionRepository(dbPath)).toThrow(/newer emploke/);
  });

  it("creates parent directory if it doesn't exist (mkdirSync recursive)", async () => {
    repo.close();
    const nested = path.join(scratchDir, "deeply", "nested", "sessions.db");
    const r = new SqliteSessionRepository(nested);
    await r.save(ID, sample);
    expect(await r.read(ID)).toEqual(sample);
    r.close();
  });

  it(":memory: dbPath gives an isolated database", async () => {
    const a = new SqliteSessionRepository(":memory:");
    const b = new SqliteSessionRepository(":memory:");
    await a.save(ID, sample);
    expect(await a.read(ID)).toEqual(sample);
    expect(await b.read(ID)).toBeNull();
    a.close();
    b.close();
  });
});
