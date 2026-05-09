import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  readPersistedSession,
  SESSION_FILE_NAME,
  writePersistedSession,
} from "../src/session-file.js";
import type { PersistedSession } from "../src/types.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "emploke-session-file-"));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const sample: PersistedSession = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  runtime: "copilot",
  createdAt: "2026-05-08T01:00:00.000Z",
  runtimeSessionId: "12345678-1234-1234-1234-1234567890ab",
};

describe("readPersistedSession", () => {
  it("returns null when file is missing", async () => {
    expect(await readPersistedSession(workdir)).toBeNull();
  });

  it("parses a valid session.json", async () => {
    await writeFile(path.join(workdir, SESSION_FILE_NAME), JSON.stringify(sample), "utf8");
    const r = await readPersistedSession(workdir);
    expect(r).toEqual({ ok: true, value: sample });
  });

  it("returns ok:false for malformed json", async () => {
    await writeFile(path.join(workdir, SESSION_FILE_NAME), "{not json", "utf8");
    const r = await readPersistedSession(workdir);
    expect(r).toMatchObject({ ok: false });
  });

  it("rejects non-object roots", async () => {
    await writeFile(path.join(workdir, SESSION_FILE_NAME), "[1,2,3]", "utf8");
    const r = await readPersistedSession(workdir);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("object") });
  });

  it("rejects newer schemaVersion with an upgrade-server hint", async () => {
    await writeFile(
      path.join(workdir, SESSION_FILE_NAME),
      JSON.stringify({ ...sample, schemaVersion: 99 }),
      "utf8",
    );
    const r = await readPersistedSession(workdir);
    expect(r).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Upgrade the server"),
    });
  });

  it("rejects older schemaVersion with a migration-not-implemented hint", async () => {
    await writeFile(
      path.join(workdir, SESSION_FILE_NAME),
      JSON.stringify({ ...sample, schemaVersion: 0 }),
      "utf8",
    );
    const r = await readPersistedSession(workdir);
    expect(r).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Migration from older versions"),
    });
  });

  it("rejects non-numeric schemaVersion as generic unsupported", async () => {
    await writeFile(
      path.join(workdir, SESSION_FILE_NAME),
      JSON.stringify({ ...sample, schemaVersion: "v1" }),
      "utf8",
    );
    const r = await readPersistedSession(workdir);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("schemaVersion") });
  });

  it("rejects missing runtime", async () => {
    const { runtime: _r, ...rest } = sample;
    await writeFile(path.join(workdir, SESSION_FILE_NAME), JSON.stringify(rest), "utf8");
    const r = await readPersistedSession(workdir);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("runtime") });
  });

  it("accepts null runtimeSessionId", async () => {
    await writeFile(
      path.join(workdir, SESSION_FILE_NAME),
      JSON.stringify({ ...sample, runtimeSessionId: null }),
      "utf8",
    );
    const r = await readPersistedSession(workdir);
    expect(r).toEqual({ ok: true, value: { ...sample, runtimeSessionId: null } });
  });

  it("rejects non-string non-null runtimeSessionId", async () => {
    await writeFile(
      path.join(workdir, SESSION_FILE_NAME),
      JSON.stringify({ ...sample, runtimeSessionId: 42 }),
      "utf8",
    );
    const r = await readPersistedSession(workdir);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("runtimeSessionId") });
  });
});

describe("writePersistedSession", () => {
  it("writes the canonical shape", async () => {
    await writePersistedSession(workdir, sample);
    const raw = await readFile(path.join(workdir, SESSION_FILE_NAME), "utf8");
    expect(JSON.parse(raw)).toEqual(sample);
  });

  it("write then read round-trips", async () => {
    await writePersistedSession(workdir, sample);
    const r = await readPersistedSession(workdir);
    expect(r).toEqual({ ok: true, value: sample });
  });

  it("does not leave any .tmp file behind on success", async () => {
    // The tmp filename uses a random suffix (`session.json.tmp.<pid>.<hex>`),
    // so glob the directory rather than checking a fixed path.
    await writePersistedSession(workdir, sample);
    const entries = await readdir(workdir);
    const tmpEntries = entries.filter((e) => e.startsWith(`${SESSION_FILE_NAME}.tmp`));
    expect(tmpEntries).toEqual([]);
  });

  it("concurrent writes do not clobber each other's tmp file", async () => {
    // Pre-fix, all writers used the same `session.json.tmp` path, so two
    // concurrent writes could end with writer-A's tmp content being moved
    // into place by writer-B's rename — and writer-B's rename could ENOENT
    // because writer-A had already renamed the (shared) tmp away. With
    // per-call random tmp suffixes, each writer has an isolated staging
    // path, so:
    //   - no writer's content is silently substituted with another's
    //   - no writer's rename ENOENTs because someone else moved its tmp
    //   - on success, no `.tmp.*` leftovers remain in the workdir
    // (Note: on Windows, two renames targeting the same destination can
    // still EPERM at the OS level — that's a separate, pre-existing
    // limitation, not what this test covers. We use allSettled so the test
    // passes regardless.)
    const variants: PersistedSession[] = Array.from({ length: 8 }, (_, i) => ({
      ...sample,
      runtimeSessionId: `12345678-1234-1234-1234-12345678900${i}`,
    }));
    const results = await Promise.allSettled(
      variants.map((v) => writePersistedSession(workdir, v)),
    );
    // At least one must succeed (otherwise the workdir is in an unusable
    // state and we have a real bug).
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    // The final content must be one of the variants — proves no torn
    // writes and no tmp-clobber substitution.
    const raw = await readFile(path.join(workdir, SESSION_FILE_NAME), "utf8");
    const parsed = JSON.parse(raw) as PersistedSession;
    expect(variants).toContainEqual(parsed);
    // No tmp leftovers regardless of who won.
    const entries = await readdir(workdir);
    expect(entries.filter((e) => e.startsWith(`${SESSION_FILE_NAME}.tmp`))).toEqual([]);
  });

  it("subsequent writes overwrite cleanly", async () => {
    await writePersistedSession(workdir, sample);
    const next: PersistedSession = { ...sample, runtimeSessionId: null };
    await writePersistedSession(workdir, next);
    const raw = await readFile(path.join(workdir, SESSION_FILE_NAME), "utf8");
    expect(JSON.parse(raw)).toEqual(next);
  });

  it("writes a trailing newline (POSIX convention)", async () => {
    await writePersistedSession(workdir, sample);
    const raw = await readFile(path.join(workdir, SESSION_FILE_NAME), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });
});

// Need a barebones missing dir test for the parent dir.
describe("readPersistedSession — workdir missing", () => {
  it("returns null when the workdir itself does not exist", async () => {
    const ghost = path.join(workdir, "does-not-exist");
    expect(await readPersistedSession(ghost)).toBeNull();
  });
});
