import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDirTrusted } from "../../src/copilot/trust.js";
import { isPathCovered } from "../../src/index.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "rt-copilot-trust-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

const targetDir = (): string => path.join(scratch, "workspace");
const configPath = (): string => path.join(scratch, "copilot-config.json");

describe("ensureDirTrusted", () => {
  // Conceptually replaces the per-session trust block in provision.test.ts.
  // The Copilot CLI prompts on every untrusted folder before allowing tool
  // use; that prompt is fatal for emploke's "open a terminal and start
  // copilot" UX. So at workspace-registration time we ensure the workspace
  // root (or any ancestor) is listed in `<config>.trustedFolders`. The
  // file we write is `~/.copilot/config.json` (NOT `settings.json`); see
  // src/copilot/trust.ts for the rationale.

  it("creates the config file with the dir trusted when it is missing", async () => {
    const t = targetDir();
    await mkdir(t, { recursive: true });
    const sp = configPath();
    expect(await exists(sp)).toBe(false);
    await ensureDirTrusted(t, sp);
    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.trustedFolders).toEqual([path.resolve(t)]);
  });

  it("appends the dir to existing trustedFolders without disturbing other keys", async () => {
    const t = targetDir();
    await mkdir(t, { recursive: true });
    const sp = configPath();
    const previous = {
      logLevel: "info",
      trustedFolders: ["/already/trusted"],
      lastLoggedInUser: { host: "https://github.com", login: "alice" },
    };
    await mkdir(path.dirname(sp), { recursive: true });
    await writeFile(sp, JSON.stringify(previous, null, 2), "utf8");

    await ensureDirTrusted(t, sp);

    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.logLevel).toBe("info");
    expect(written.lastLoggedInUser).toEqual(previous.lastLoggedInUser);
    expect(written.trustedFolders).toEqual(["/already/trusted", path.resolve(t)]);
  });

  it("does not duplicate the entry when the dir is already trusted", async () => {
    const t = targetDir();
    await mkdir(t, { recursive: true });
    const sp = configPath();
    const previous = { trustedFolders: [path.resolve(t)] };
    await mkdir(path.dirname(sp), { recursive: true });
    await writeFile(sp, JSON.stringify(previous, null, 2), "utf8");

    await ensureDirTrusted(t, sp);

    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.trustedFolders).toEqual([path.resolve(t)]);
  });

  it("treats a parent of the dir as covering, leaving config unchanged", async () => {
    // Once `~/.emploke` is trusted, every workspace under it is covered and
    // we should never re-add per-workspace entries.
    const ancestor = scratch;
    const t = path.join(ancestor, "deep", "nested", "workspace");
    await mkdir(t, { recursive: true });
    const sp = configPath();
    const previous = { trustedFolders: [ancestor] };
    await mkdir(path.dirname(sp), { recursive: true });
    await writeFile(sp, JSON.stringify(previous, null, 2), "utf8");

    await ensureDirTrusted(t, sp);

    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.trustedFolders).toEqual([ancestor]);
  });

  it("does NOT confuse a sibling-prefix string for a parent (e.g. /foo vs /foobar)", async () => {
    const t = path.join(scratch, "foobar", "workspace");
    await mkdir(t, { recursive: true });
    const sp = configPath();
    const sibling = path.join(scratch, "foo");
    const previous = { trustedFolders: [sibling] };
    await mkdir(path.dirname(sp), { recursive: true });
    await writeFile(sp, JSON.stringify(previous, null, 2), "utf8");

    await ensureDirTrusted(t, sp);

    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.trustedFolders).toEqual([sibling, path.resolve(t)]);
  });

  it("recovers when config.json is malformed by starting fresh", async () => {
    const t = targetDir();
    await mkdir(t, { recursive: true });
    const sp = configPath();
    await mkdir(path.dirname(sp), { recursive: true });
    await writeFile(sp, "{not valid json", "utf8");

    await ensureDirTrusted(t, sp);

    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.trustedFolders).toEqual([path.resolve(t)]);
  });

  it("ignores non-string entries in an existing trustedFolders array", async () => {
    const t = targetDir();
    await mkdir(t, { recursive: true });
    const sp = configPath();
    const previous = { trustedFolders: [42, null, "/already", { not: "a string" }] };
    await mkdir(path.dirname(sp), { recursive: true });
    await writeFile(sp, JSON.stringify(previous), "utf8");

    await ensureDirTrusted(t, sp);

    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.trustedFolders).toEqual(["/already", path.resolve(t)]);
  });

  // Concurrency hardening: the read-modify-write cycle on config.json is
  // protected by an O_EXCL lock file. Without the lock, two parallel
  // buildLaunch preflights would both pass `isPathCovered` before either
  // wrote, then the second `rename()` would clobber the first writer's
  // entries (and any unrelated keys the user happened to have between the
  // two reads). These tests pin the lock behavior.

  it("serialises concurrent calls: every dir ends up trusted exactly once", async () => {
    const sp = configPath();
    const dirs: string[] = [];
    for (let i = 0; i < 8; i++) {
      const w = path.join(scratch, `concurrent-${i}`);
      dirs.push(w);
      await mkdir(w, { recursive: true });
    }
    await Promise.all(dirs.map((w) => ensureDirTrusted(w, sp)));

    const written = JSON.parse(await readFile(sp, "utf8"));
    const trusted: string[] = written.trustedFolders;
    for (const w of dirs) {
      expect(trusted).toContain(path.resolve(w));
    }
    const uniq = new Set(trusted);
    expect(uniq.size).toBe(trusted.length);
  });

  it("preserves unrelated keys across concurrent calls (no lost-update on logLevel)", async () => {
    const sp = configPath();
    await mkdir(path.dirname(sp), { recursive: true });
    await writeFile(
      sp,
      `${JSON.stringify({ logLevel: "info", lastLoggedInUser: { login: "alice" } }, null, 2)}\n`,
      "utf8",
    );

    const dirs = Array.from({ length: 6 }, (_, i) => path.join(scratch, `co-${i}`));
    for (const d of dirs) await mkdir(d, { recursive: true });
    await Promise.all(dirs.map((d) => ensureDirTrusted(d, sp)));

    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.logLevel).toBe("info");
    expect(written.lastLoggedInUser).toEqual({ login: "alice" });
    for (const d of dirs) {
      expect(written.trustedFolders).toContain(path.resolve(d));
    }
  });

  it("releases the lock file on success (no zombie lock)", async () => {
    const t = targetDir();
    await mkdir(t, { recursive: true });
    const sp = configPath();
    await ensureDirTrusted(t, sp);
    expect(await exists(`${sp}.lock`)).toBe(false);
  });

  it("includes holder PID in the timeout error so operators can find the wedged process", async () => {
    const sp = configPath();
    await mkdir(path.dirname(sp), { recursive: true });
    const lockPath = `${sp}.lock`;
    // Use *our own* PID as the fake holder. Liveness check (process.kill(pid, 0))
    // will succeed because we are alive, so the new tryStealStaleLock will
    // refuse to steal even though the file would otherwise look stealable.
    // That makes the timeout (rather than a steal) the deterministic outcome.
    await writeFile(lockPath, `${process.pid}\n`, "utf8");

    const t = targetDir();
    await mkdir(t, { recursive: true });
    await expect(ensureDirTrusted(t, sp)).rejects.toThrow(new RegExp(`PID ${process.pid}`));
  }, 15000);

  it("steals a fresh lock whose recorded PID is dead (process.kill ESRCH)", async () => {
    // This pins the new PID-guard behaviour: a lock with a dead-process PID
    // is taken immediately, regardless of mtime. Without the guard, a
    // crashed buildLaunch caller would block fresh writes for the
    // full LOCK_STALE_MS (30s) until the mtime-based heuristic kicked in.
    const dead = findDeadPid();
    if (dead === null) {
      // No portable way to forge a dead PID on this host; skip silently.
      return;
    }
    const sp = configPath();
    await mkdir(path.dirname(sp), { recursive: true });
    const lockPath = `${sp}.lock`;
    await writeFile(lockPath, `${dead}\n`, "utf8");

    const t = targetDir();
    await mkdir(t, { recursive: true });
    const before = Date.now();
    await ensureDirTrusted(t, sp);
    const elapsed = Date.now() - before;
    expect(elapsed).toBeLessThan(2000);
    const written = JSON.parse(await readFile(sp, "utf8"));
    expect(written.trustedFolders).toEqual([path.resolve(t)]);
  });
});

/**
 * Find a PID the OS reports as definitely dead. We need this to exercise
 * the stale-lock path; on most systems any sufficiently large positive
 * integer works because PIDs wrap well below it. We verify with
 * `process.kill(pid, 0)` so the test stays self-checking.
 */
function findDeadPid(): number | null {
  for (const candidate of [99999999, 999999, 9999999]) {
    try {
      process.kill(candidate, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  return null;
}

describe("isPathCovered", () => {
  it("returns true on exact match", () => {
    expect(isPathCovered("/foo/bar", ["/foo/bar"])).toBe(true);
  });

  it("returns true when target is nested in a trusted ancestor", () => {
    expect(isPathCovered("/foo/bar/baz", ["/foo"])).toBe(true);
  });

  it("returns false when target is unrelated", () => {
    expect(isPathCovered("/foo/bar", ["/other"])).toBe(false);
  });

  it("does not treat a sibling prefix as a parent (/foo does not cover /foobar)", () => {
    expect(isPathCovered("/foobar", ["/foo"])).toBe(false);
  });

  it("ignores empty/non-string entries", () => {
    expect(isPathCovered("/foo/bar", ["", "/foo/bar"])).toBe(true);
  });

  it("normalises both sides via path.resolve", () => {
    expect(isPathCovered("./foo/../bar", [path.resolve("bar")])).toBe(true);
  });
});
