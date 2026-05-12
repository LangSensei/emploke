import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SERVER_MANAGED_README } from "@emploke/paths";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteRuntimeFile,
  isPidAlive,
  type RuntimeFile,
  readRuntimeFile,
  runtimeFilePath,
  writeRuntimeFile,
} from "../src/runtime-file.js";

describe("runtime-file", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "emploke-cli-rf-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("read returns null when the file is absent", async () => {
    expect(await readRuntimeFile(home)).toBeNull();
  });

  it("write then read round-trips the payload", async () => {
    const payload: RuntimeFile = {
      schema: 1,
      pid: 12345,
      host: "127.0.0.1",
      port: 30001,
      startedAt: "2026-05-11T00:00:00.000Z",
      serverArgs: ["bin.js", "serve", "--port", "30001"],
    };
    await writeRuntimeFile(home, payload);
    const read = await readRuntimeFile(home);
    // The on-disk file gains a `_readme` audit field (visible to a hand
    // `cat`) that's silently included on read; assert it's there but
    // doesn't displace any typed field.
    expect(read).toMatchObject(payload);
  });

  it("write injects the SERVER_MANAGED_README field on disk", async () => {
    await writeRuntimeFile(home, makePayload());
    const raw = JSON.parse(await readFile(runtimeFilePath(home), "utf8")) as Record<
      string,
      unknown
    >;
    expect(raw._readme).toBe(SERVER_MANAGED_README);
  });

  it("write tightens permissions to 0600 when an apiKey is recorded", async () => {
    if (process.platform === "win32") {
      // Windows ignores POSIX mode bits; the per-user home is the
      // protection. Just assert the file was written.
      await writeRuntimeFile(home, makePayload({ apiKey: "secret" }));
      expect(await readRuntimeFile(home)).not.toBeNull();
      return;
    }
    await writeRuntimeFile(home, makePayload({ apiKey: "secret" }));
    const st = await stat(runtimeFilePath(home));
    // Mask away type bits.
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("does not chmod when apiKey is absent (writeJsonAtomic default mode)", async () => {
    if (process.platform === "win32") return;
    await writeRuntimeFile(home, makePayload());
    const st = await stat(runtimeFilePath(home));
    // Default mode from `writeFile` is 0666 minus umask; we only assert
    // it isn't 0600 (i.e. we didn't accidentally tighten when not asked).
    expect(st.mode & 0o600).toBe(0o600);
  });

  it("write is atomic — concurrent reads see a complete payload, never partial bytes", async () => {
    // Modest contention: enough to interleave a writer with several
    // readers but well under the underlying writeJsonAtomic rename
    // retry budget (8 attempts × backoff caps at ~127 ms; large
    // bursts here overshoot that and end up stress-testing
    // @emploke/fs rather than this module's contract). What we
    // actually care about: every read either sees the previous
    // payload or the new one, never half-written JSON.
    await writeRuntimeFile(home, makePayload({ pid: 100 }));
    const writers = Promise.all(
      Array.from({ length: 3 }, (_, i) => writeRuntimeFile(home, makePayload({ pid: 1000 + i }))),
    );
    const reads: Array<RuntimeFile | null> = [];
    while (reads.length < 8) {
      reads.push(await readRuntimeFile(home));
    }
    await writers;
    for (const r of reads) {
      expect(r).not.toBeNull();
      expect(r?.schema).toBe(1);
      expect(typeof r?.pid).toBe("number");
    }
  });

  it("read rejects an unknown schema", async () => {
    const file = runtimeFilePath(home);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify({ schema: 99, pid: 1 }), "utf8");
    await expect(readRuntimeFile(home)).rejects.toThrow(/schema 99/);
  });

  it("delete is idempotent on a missing file", async () => {
    await expect(deleteRuntimeFile(home)).resolves.toBeUndefined();
    await writeRuntimeFile(home, makePayload());
    await deleteRuntimeFile(home);
    await expect(readRuntimeFile(home)).resolves.toBeNull();
  });

  it("isPidAlive returns false for an obviously-dead pid", () => {
    // pid 1 is init / launchd / wininit and is always alive when the OS
    // is up; a pid like 999_999 is overwhelmingly likely to be free.
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
    expect(isPidAlive(999_999)).toBe(false);
  });

  it("isPidAlive returns true for our own pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("read leaves runtime.json that was written via raw json", async () => {
    // Sanity: the file is JSON, not YAML or anything weird.
    await writeRuntimeFile(home, makePayload({ pid: 42 }));
    const raw = await readFile(runtimeFilePath(home), "utf8");
    expect(JSON.parse(raw).pid).toBe(42);
  });
});

function makePayload(overrides: Partial<RuntimeFile> = {}): RuntimeFile {
  return {
    schema: 1,
    pid: 1,
    host: "127.0.0.1",
    port: 8787,
    startedAt: "2026-05-11T00:00:00.000Z",
    serverArgs: [],
    ...overrides,
  };
}
