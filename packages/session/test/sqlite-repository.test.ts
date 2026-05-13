import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidSessionIdError } from "../src/errors.js";
import { Session, SqliteSessionRepository } from "../src/index.js";

let db: DatabaseSync;
let repo: SqliteSessionRepository;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  repo = new SqliteSessionRepository({ db });
});
afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
});

const ID = "20260509-aabbccdd";

function sample(
  overrides: {
    runtime?: string;
    createdAt?: string;
    runtimeSessionId?: string | null;
    lastLaunchMode?: "local" | "remote";
  } = {},
): Session {
  return Session.create({
    runtime: overrides.runtime ?? "copilot",
    createdAt: overrides.createdAt ?? "2026-05-09T01:00:00.000Z",
    runtimeSessionId: overrides.runtimeSessionId !== undefined ? overrides.runtimeSessionId : "abc",
    ...(overrides.lastLaunchMode !== undefined ? { lastLaunchMode: overrides.lastLaunchMode } : {}),
  });
}

describe("SqliteSessionRepository", () => {
  it("save + read round-trip", async () => {
    const s = sample();
    await repo.save(ID, s);
    const back = await repo.read(ID);
    expect(back?.toJSON()).toEqual(s.toJSON());
  });

  it("save + read round-trip preserves lastLaunchMode", async () => {
    const s = sample({ lastLaunchMode: "remote" });
    await repo.save(ID, s);
    const back = await repo.read(ID);
    expect(back?.lastLaunchMode).toBe("remote");
    expect(back?.runtime).toBe(s.runtime);
    expect(back?.createdAt).toBe(s.createdAt);
    expect(back?.runtimeSessionId).toBe(s.runtimeSessionId);
  });

  it("save is idempotent (INSERT OR REPLACE)", async () => {
    await repo.save(ID, sample());
    await repo.save(ID, sample({ runtimeSessionId: "updated" }));
    const back = await repo.read(ID);
    expect(back?.runtimeSessionId).toBe("updated");
  });

  it("patchLastLaunchMode updates only the column, leaves other fields untouched", async () => {
    const s = sample();
    await repo.save(ID, s);
    await repo.patchLastLaunchMode(ID, "remote");
    const back = await repo.read(ID);
    // runtime / createdAt / runtimeSessionId all preserved verbatim.
    expect(back?.runtime).toBe(s.runtime);
    expect(back?.createdAt).toBe(s.createdAt);
    expect(back?.runtimeSessionId).toBe(s.runtimeSessionId);
    expect(back?.lastLaunchMode).toBe("remote");
  });

  it("patchLastLaunchMode overwrites a previous mode (last writer wins)", async () => {
    await repo.save(ID, sample({ lastLaunchMode: "local" }));
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
    await repo.save(ID, sample());
    await Promise.all([
      repo.save(ID, sample({ runtimeSessionId: "from-refresh" })),
      repo.patchLastLaunchMode(ID, "remote"),
    ]);
    const back = await repo.read(ID);
    expect(back?.runtimeSessionId).toBe("from-refresh");
    expect(back?.lastLaunchMode).toBe("remote");
  });

  it("save preserves runtimeSessionId === null", async () => {
    await repo.save(ID, sample({ runtimeSessionId: null }));
    const back = await repo.read(ID);
    expect(back?.runtimeSessionId).toBeNull();
  });

  it("read returns null for missing id", async () => {
    expect(await repo.read("20990101-deadbeef")).toBeNull();
  });

  it("delete removes the row; subsequent read returns null", async () => {
    await repo.save(ID, sample());
    await repo.delete(ID);
    expect(await repo.read(ID)).toBeNull();
  });

  it("delete is idempotent for missing id", async () => {
    await repo.delete("20990101-cafebabe");
  });

  it("read/save reject malformed ids with InvalidSessionIdError", async () => {
    await expect(repo.read("../../etc/passwd")).rejects.toBeInstanceOf(InvalidSessionIdError);
    await expect(
      repo.save(
        "../../etc",
        Session.create({ runtime: "x", createdAt: "x", runtimeSessionId: null }),
      ),
    ).rejects.toBeInstanceOf(InvalidSessionIdError);
  });

  it("delete with malformed id is a silent no-op (matches FS behaviour)", async () => {
    const s = sample();
    await repo.save(ID, s);
    await repo.delete("../../etc/passwd");
    // Original row untouched.
    const back = await repo.read(ID);
    expect(back?.toJSON()).toEqual(s.toJSON());
  });

  it("list returns all rows when no filter", async () => {
    await repo.save("20260101-aaaaaaaa", sample({ createdAt: "2026-01-01T00:00:00.000Z" }));
    await repo.save("20260601-bbbbbbbb", sample({ createdAt: "2026-06-01T00:00:00.000Z" }));
    const all = await repo.list();
    expect(all.map((e) => e.id).sort()).toEqual(["20260101-aaaaaaaa", "20260601-bbbbbbbb"]);
  });

  it("list applies createdSince filter (>=, ISO 8601 lex sort)", async () => {
    await repo.save("20260101-aaaaaaaa", sample({ createdAt: "2026-01-01T00:00:00.000Z" }));
    await repo.save("20260601-bbbbbbbb", sample({ createdAt: "2026-06-01T00:00:00.000Z" }));
    const since = await repo.list({ createdSince: "2026-03-01T00:00:00.000Z" });
    expect(since).toHaveLength(1);
    expect(since[0]?.id).toBe("20260601-bbbbbbbb");
  });

  it("rejects opening a workspace.db with a future schema version for the session pkg", async () => {
    // Bump the session pkg's row to a future version and re-construct
    // a fresh repo against the same DB; ensureSchema must throw.
    db.prepare("UPDATE schema_meta SET version = 999 WHERE pkg = ?").run("session");
    expect(() => new SqliteSessionRepository({ db })).toThrow(/schema mismatch/);
  });

  it("two separate :memory: connections are isolated", async () => {
    const dbA = new DatabaseSync(":memory:");
    const dbB = new DatabaseSync(":memory:");
    const a = new SqliteSessionRepository({ db: dbA });
    const b = new SqliteSessionRepository({ db: dbB });
    const s = sample();
    await a.save(ID, s);
    expect((await a.read(ID))?.toJSON()).toEqual(s.toJSON());
    expect(await b.read(ID)).toBeNull();
    dbA.close();
    dbB.close();
  });
});
