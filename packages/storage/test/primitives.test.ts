import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirP,
  readJson,
  StorageLockTimeoutError,
  safeReaddir,
  safeStat,
  withFileLock,
  writeFileAtomic,
  writeJsonAtomic,
} from "../src/index.js";

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-storage-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("writes the content and leaves no tmp file behind", async () => {
    const file = path.join(scratch, "out.txt");
    await writeFileAtomic(file, "hello");
    const entries = await readdir(scratch);
    expect(entries).toEqual(["out.txt"]);
    expect(await readFile(file, "utf8")).toBe("hello");
  });

  it("overwrites an existing file atomically (readers never see partial bytes)", async () => {
    const file = path.join(scratch, "out.txt");
    await writeFile(file, "old", "utf8");
    await writeFileAtomic(file, "new");
    expect(await readFile(file, "utf8")).toBe("new");
  });

  it("two concurrent writers do not clobber each other's tmp files", async () => {
    const file = path.join(scratch, "out.txt");
    // 10 parallel writes; the tmp suffix uses pid + random hex so no two
    // writers should rename onto each other's tmp. (Higher concurrency
    // is a fs-stress test, not an atomic-write test — keep it modest
    // to avoid Windows EPERM/EBUSY noise during CI.)
    await Promise.all(Array.from({ length: 10 }, (_, i) => writeFileAtomic(file, `payload-${i}`)));
    // Last write wins; orphans are not allowed.
    const entries = await readdir(scratch);
    expect(entries).toEqual(["out.txt"]);
  });
});

describe("writeJsonAtomic + readJson", () => {
  it("round-trips a JSON value with trailing newline", async () => {
    const file = path.join(scratch, "x.json");
    await writeJsonAtomic(file, { a: 1, b: ["x", "y"] });
    const raw = await readFile(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const back = await readJson<{ a: number; b: string[] }>(file);
    expect(back).toEqual({ a: 1, b: ["x", "y"] });
  });

  it("readJson returns null for a missing file (ENOENT)", async () => {
    const r = await readJson(path.join(scratch, "missing.json"));
    expect(r).toBeNull();
  });

  it("readJson throws on malformed JSON", async () => {
    const file = path.join(scratch, "bad.json");
    await writeFile(file, "not json", "utf8");
    await expect(readJson(file)).rejects.toThrow();
  });
});

describe("safeReaddir / safeStat / mkdirP", () => {
  it("safeReaddir returns [] on missing dir", async () => {
    const r = await safeReaddir(path.join(scratch, "no-such"));
    expect(r).toEqual([]);
  });

  it("safeStat returns null on missing path", async () => {
    const r = await safeStat(path.join(scratch, "no-such"));
    expect(r).toBeNull();
  });

  it("mkdirP creates nested dirs and is idempotent", async () => {
    const nested = path.join(scratch, "a", "b", "c");
    await mkdirP(nested);
    await mkdirP(nested);
    const st = await safeStat(nested);
    expect(st).not.toBeNull();
    expect(st?.isDirectory()).toBe(true);
  });
});

describe("withFileLock", () => {
  it("serializes concurrent critical sections", async () => {
    const lockPath = path.join(scratch, "x.lock");
    let inFlight = 0;
    let maxInFlight = 0;
    const tick = async () => {
      await withFileLock(lockPath, async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      });
    };
    await Promise.all(Array.from({ length: 10 }, tick));
    expect(maxInFlight).toBe(1);
  });

  it("releases the lock even if fn throws", async () => {
    const lockPath = path.join(scratch, "x.lock");
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Subsequent acquisition must succeed (lock file removed in finally).
    let ran = false;
    await withFileLock(lockPath, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("throws StorageLockTimeoutError on contention beyond waitMs", async () => {
    const lockPath = path.join(scratch, "x.lock");
    // Hold the lock for longer than the second caller's waitMs.
    const release = (() => {
      let resolveFn!: () => void;
      const p = new Promise<void>((res) => {
        resolveFn = res;
      });
      void withFileLock(lockPath, async () => {
        await p;
      });
      return resolveFn;
    })();
    // Give the holder a moment to actually acquire.
    await new Promise((r) => setTimeout(r, 10));
    try {
      await expect(
        withFileLock(lockPath, async () => undefined, { waitMs: 50 }),
      ).rejects.toBeInstanceOf(StorageLockTimeoutError);
    } finally {
      release();
    }
  });

  it("steals a lock whose holder PID is dead", async () => {
    const lockPath = path.join(scratch, "x.lock");
    // Plant a lock file with a PID that is almost certainly not alive.
    // Pick a PID we know is dead by spawning a child and waiting for exit.
    // Easier: use 1 (init / system process) — process.kill(1, 0) would
    // typically be EPERM, which we treat as alive. So instead pick a
    // very high PID unlikely to be allocated.
    // Plant PID 999999, which on most systems will not be live.
    await writeFile(lockPath, "999999\n", "utf8");
    // Second arg older-than-stale so the mtime fallback would also kick
    // in if PID parse failed; either path leads to stealing.
    let ran = false;
    await withFileLock(
      lockPath,
      async () => {
        ran = true;
      },
      { waitMs: 1000, staleMs: 0 },
    );
    expect(ran).toBe(true);
  });
});
