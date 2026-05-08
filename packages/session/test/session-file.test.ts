import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("rejects unsupported schemaVersion", async () => {
    await writeFile(
      path.join(workdir, SESSION_FILE_NAME),
      JSON.stringify({ ...sample, schemaVersion: 99 }),
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

  it("does not leave the .tmp file behind on success", async () => {
    await writePersistedSession(workdir, sample);
    await expect(
      readFile(path.join(workdir, `${SESSION_FILE_NAME}.tmp`), "utf8"),
    ).rejects.toThrow();
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
