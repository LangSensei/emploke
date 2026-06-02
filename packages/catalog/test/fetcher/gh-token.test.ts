import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for `gh-token.ts`. We mock `node:child_process.spawn` so the suite
 * is hermetic — never actually shells out to gh. The mock is installed at
 * module-load time via `vi.mock` so the resolver picks it up on first import.
 *
 * stdout is modelled as a plain EventEmitter (not a real Readable) so that
 * `data` / `end` / `close` are emitted in deterministic order — a real
 * Readable buffers pushes asynchronously and would race the close event.
 */

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter | null;
  kill(signal?: string): boolean;
}

type SpawnFactory = () => MockChildProcess;

let spawnFactory: SpawnFactory | null = null;
let spawnSpy = vi.fn<(...args: unknown[]) => void>();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => {
    spawnSpy(...args);
    if (!spawnFactory) throw new Error("test forgot to install spawnFactory");
    return spawnFactory();
  },
}));

const { _resetGhTokenCache, resolveDefaultGitHubToken, tryGhAuthToken } = await import(
  "../../src/fetcher/gh-token.js"
);

function makeMockChild(): MockChildProcess {
  const ee = new EventEmitter() as MockChildProcess;
  ee.stdout = null;
  ee.kill = vi.fn().mockReturnValue(true);
  return ee;
}

/**
 * Build a `gh` mock that emits `chunks` on stdout, then closes with `exitCode`.
 * Both the data emit and the close emit are scheduled on the same microtask
 * after the resolver has had a chance to attach its listeners (spawn returns
 * synchronously; the resolver attaches in the same tick).
 */
function makeGhMock(chunks: string[], exitCode: number): SpawnFactory {
  return () => {
    const ee = makeMockChild();
    const stdout = new EventEmitter();
    ee.stdout = stdout;
    queueMicrotask(() => {
      for (const c of chunks) stdout.emit("data", Buffer.from(c));
      ee.emit("close", exitCode);
    });
    return ee;
  };
}

const ORIG_GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORIG_GH_TOKEN = process.env.GH_TOKEN;

beforeEach(() => {
  _resetGhTokenCache();
  spawnSpy = vi.fn();
  spawnFactory = null;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  vi.useRealTimers();
});

afterEach(() => {
  if (ORIG_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = ORIG_GITHUB_TOKEN;
  if (ORIG_GH_TOKEN === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = ORIG_GH_TOKEN;
});

describe("resolveDefaultGitHubToken — env-var path", () => {
  it("returns GITHUB_TOKEN when set, never invoking gh", async () => {
    process.env.GITHUB_TOKEN = "gho_envtoken123";
    const t = await resolveDefaultGitHubToken("github.com");
    expect(t).toBe("gho_envtoken123");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("returns GH_TOKEN when GITHUB_TOKEN absent", async () => {
    process.env.GH_TOKEN = "ghp_legacyenv456";
    const t = await resolveDefaultGitHubToken("github.com");
    expect(t).toBe("ghp_legacyenv456");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("prefers GITHUB_TOKEN over GH_TOKEN when both set", async () => {
    process.env.GITHUB_TOKEN = "gho_primary";
    process.env.GH_TOKEN = "gho_secondary";
    const t = await resolveDefaultGitHubToken("github.com");
    expect(t).toBe("gho_primary");
  });

  it("does NOT use cached gh token when env appears mid-run", async () => {
    spawnFactory = makeGhMock(["gho_fromgh999\n"], 0);
    expect(await resolveDefaultGitHubToken("github.com")).toBe("gho_fromgh999");

    process.env.GITHUB_TOKEN = "gho_envwins";
    expect(await resolveDefaultGitHubToken("github.com")).toBe("gho_envwins");
  });
});

describe("resolveDefaultGitHubToken — gh fallback", () => {
  it("returns trimmed token when gh exits 0 with valid stdout", async () => {
    spawnFactory = makeGhMock(["gho_validgh777\n"], 0);
    const t = await resolveDefaultGitHubToken("github.com");
    expect(t).toBe("gho_validgh777");
    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(spawnSpy).toHaveBeenCalledWith(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      expect.objectContaining({
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }),
    );
  });

  it("returns null when gh exits non-zero", async () => {
    spawnFactory = makeGhMock([""], 1);
    const t = await resolveDefaultGitHubToken("github.com");
    expect(t).toBeNull();
  });

  it("returns null and does NOT throw when spawn throws ENOENT", async () => {
    spawnFactory = () => {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    };
    const t = await resolveDefaultGitHubToken("github.com");
    expect(t).toBeNull();
  });

  it("returns null when gh emits an 'error' event", async () => {
    spawnFactory = () => {
      const ee = makeMockChild();
      queueMicrotask(() => ee.emit("error", new Error("EPERM")));
      return ee;
    };
    const t = await resolveDefaultGitHubToken("github.com");
    expect(t).toBeNull();
  });

  it("returns null when stdout doesn't look like a github token", async () => {
    spawnFactory = makeGhMock(["hello world\n"], 0);
    const t = await resolveDefaultGitHubToken("github.com");
    expect(t).toBeNull();
  });

  it("accepts all canonical github token prefixes", async () => {
    const prefixes = ["gho_", "ghp_", "ghs_", "ghu_", "github_pat_"];
    for (const prefix of prefixes) {
      _resetGhTokenCache();
      spawnFactory = makeGhMock([`${prefix}abc123XYZ_def\n`], 0);
      const t = await resolveDefaultGitHubToken("github.com");
      expect(t, `prefix ${prefix} should be accepted`).toBe(`${prefix}abc123XYZ_def`);
    }
  });

  it("kills gh and returns null on timeout", async () => {
    vi.useFakeTimers();
    let killed = false;
    spawnFactory = () => {
      const ee = makeMockChild();
      ee.kill = vi.fn().mockImplementation(() => {
        killed = true;
        return true;
      });
      ee.stdout = new EventEmitter();
      return ee;
    };
    const promise = tryGhAuthToken("github.com");
    await vi.advanceTimersByTimeAsync(5_000);
    const t = await promise;
    expect(t).toBeNull();
    expect(killed).toBe(true);
    vi.useRealTimers();
  });
});

describe("resolveDefaultGitHubToken — caching", () => {
  it("caches successful gh token within TTL (one spawn for two calls)", async () => {
    let spawned = 0;
    spawnFactory = () => {
      spawned++;
      const ee = makeMockChild();
      const stdout = new EventEmitter();
      ee.stdout = stdout;
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from("gho_cachedme\n"));
        ee.emit("close", 0);
      });
      return ee;
    };
    expect(await resolveDefaultGitHubToken("github.com")).toBe("gho_cachedme");
    expect(await resolveDefaultGitHubToken("github.com")).toBe("gho_cachedme");
    expect(spawned).toBe(1);
  });

  it("caches a null result so repeated calls don't re-spawn gh", async () => {
    let spawned = 0;
    spawnFactory = () => {
      spawned++;
      return makeGhMock([""], 1)();
    };
    expect(await resolveDefaultGitHubToken("github.com")).toBeNull();
    expect(await resolveDefaultGitHubToken("github.com")).toBeNull();
    expect(spawned).toBe(1);
  });

  it("re-spawns after the cache TTL elapses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, now: Date.now() });
    let spawned = 0;
    spawnFactory = () => {
      spawned++;
      const ee = makeMockChild();
      const stdout = new EventEmitter();
      ee.stdout = stdout;
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from(spawned === 1 ? "gho_first\n" : "gho_second\n"));
        ee.emit("close", 0);
      });
      return ee;
    };
    expect(await resolveDefaultGitHubToken("github.com")).toBe("gho_first");

    vi.setSystemTime(Date.now() + 61_000);

    expect(await resolveDefaultGitHubToken("github.com")).toBe("gho_second");
    expect(spawned).toBe(2);
    vi.useRealTimers();
  });

  it("caches per-host: different hosts spawn independently", async () => {
    let spawned = 0;
    spawnFactory = () => {
      spawned++;
      return makeGhMock(["gho_anyhost\n"], 0)();
    };
    await resolveDefaultGitHubToken("github.com");
    await resolveDefaultGitHubToken("github.acme.com");
    await resolveDefaultGitHubToken("github.com");
    expect(spawned).toBe(2);
  });

  it("normalises host case before caching (GitHub.COM == github.com)", async () => {
    let spawned = 0;
    spawnFactory = () => {
      spawned++;
      return makeGhMock(["gho_caseinsensitive\n"], 0)();
    };
    expect(await resolveDefaultGitHubToken("GitHub.COM")).toBe("gho_caseinsensitive");
    expect(await resolveDefaultGitHubToken("github.com")).toBe("gho_caseinsensitive");
    expect(await resolveDefaultGitHubToken("GITHUB.COM")).toBe("gho_caseinsensitive");
    expect(spawned).toBe(1);
    // The argument actually passed to `gh` is also lower-cased, for parity.
    expect(spawnSpy).toHaveBeenCalledWith(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      expect.anything(),
    );
  });
});

describe("resolveDefaultGitHubToken — diagnostics", () => {
  it("emits a process warning when stdout doesn't look like a token", async () => {
    spawnFactory = makeGhMock(["this-is-not-a-token\n"], 0);

    // process.emitWarning dispatches on a future tick, so we await a
    // dedicated promise that resolves on the first matching warning rather
    // than racing the test's finally block against the warning queue.
    const warningPromise = new Promise<NodeJS.ErrnoException | null>((resolve) => {
      const handler = (warning: Error): void => {
        const w = warning as NodeJS.ErrnoException;
        if (w.code === "EMPLOKE_GH_TOKEN_FORMAT") {
          process.off("warning", handler);
          resolve(w);
        }
      };
      process.on("warning", handler);
      // Defensive 1s timeout so a regression that drops the warning shows
      // up as a clear assertion failure instead of a hanging test.
      setTimeout(() => {
        process.off("warning", handler);
        resolve(null);
      }, 1_000);
    });

    const t = await resolveDefaultGitHubToken("github.com");
    expect(t).toBeNull();

    const w = await warningPromise;
    expect(w, "expected an EMPLOKE_GH_TOKEN_FORMAT warning").not.toBeNull();
    expect(w!.message).toMatch(/does not look like a GitHub token/);
    expect(w!.message).toMatch(/falling back to anonymous/);
  });

  it("does NOT emit a warning on the normal 'gh isn't configured' paths", async () => {
    let formatWarnings = 0;
    const handler = (warning: Error): void => {
      if ((warning as NodeJS.ErrnoException).code === "EMPLOKE_GH_TOKEN_FORMAT") {
        formatWarnings++;
      }
    };
    process.on("warning", handler);
    try {
      // gh exits non-zero — normal "not logged in" path, no warning.
      spawnFactory = makeGhMock([""], 1);
      _resetGhTokenCache();
      await resolveDefaultGitHubToken("github.com");

      // gh not installed (ENOENT) — normal "no gh on machine" path, no warning.
      spawnFactory = () => {
        throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      };
      _resetGhTokenCache();
      await resolveDefaultGitHubToken("github.com");

      // Drain any queued warnings before asserting.
      await new Promise<void>((r) => setImmediate(r));
    } finally {
      process.off("warning", handler);
    }
    expect(formatWarnings).toBe(0);
  });
});
