import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for `ado-token.ts`. We mock `node:child_process.spawn` so the suite
 * is hermetic — never actually shells out to `git`. The mock is installed
 * at module-load time via `vi.mock` so the resolver picks it up on first
 * import. Mirrors the structure of `gh-token.test.ts`.
 *
 * Each test installs a `spawnFactory` that, given the spawn argv, returns
 * a `MockChildProcess` shaped like the relevant `git credential <action>`
 * response (silent fill / interactive fill / approve / reject). Routing
 * by argv lets a single mock cover the three-step protocol end-to-end.
 *
 * `process.stdin.isTTY`, `process.env.CI`, `process.env.GLYPHS_NON_INTERACTIVE`,
 * `process.emitWarning`, and `process.stderr.write` are all stubbed in
 * `beforeEach` and restored in `afterEach` so a test that flips one
 * doesn't poison its neighbours.
 */

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter | null;
  stdin: { write: (data: string, cb?: (err?: Error) => void) => boolean; end: () => void } | null;
  kill(signal?: string): boolean;
}

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: { env?: NodeJS.ProcessEnv; stdio?: unknown; windowsHide?: boolean } & Record<
    string,
    unknown
  >;
  /** Concatenated bytes written by the caller to the child's stdin. */
  stdin: string;
}

type SpawnFactory = (call: SpawnCall) => MockChildProcess;

let spawnFactory: SpawnFactory | null = null;
let spawnCalls: SpawnCall[] = [];

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts: unknown) => {
    if (!spawnFactory) throw new Error("test forgot to install spawnFactory");
    const call: SpawnCall = {
      cmd,
      args,
      opts: (opts ?? {}) as SpawnCall["opts"],
      stdin: "",
    };
    spawnCalls.push(call);
    const child = spawnFactory(call);
    // Wrap stdin.write to record every chunk against this specific call,
    // so tests can assert per-call stdin bodies regardless of order.
    const origStdin = child.stdin;
    if (origStdin !== null) {
      const origWrite = origStdin.write.bind(origStdin);
      origStdin.write = (data: string, cb?: (err?: Error) => void): boolean => {
        call.stdin += data;
        return origWrite(data, cb);
      };
    }
    return child;
  },
}));

const {
  _resetAdoTokenCache,
  gitCredentialApprove,
  gitCredentialReject,
  invalidateAdoTokenCache,
  resolveDefaultAdoToken,
  tryGitCredentialFill,
} = await import("../../src/fetcher/ado-token.js");
const { FetchError } = await import("../../src/fetcher/errors.js");

function makeMockChild(): MockChildProcess {
  const ee = new EventEmitter() as MockChildProcess;
  ee.stdout = null;
  ee.stdin = {
    write: vi.fn((_data: string, cb?: (err?: Error) => void): boolean => {
      cb?.();
      return true;
    }),
    end: vi.fn(),
  };
  ee.kill = vi.fn().mockReturnValue(true);
  return ee;
}

/** Mock child that emits `chunks` on stdout, then closes with exit code 0. */
function fillSuccess(chunks: string[]): MockChildProcess {
  const ee = makeMockChild();
  const stdout = new EventEmitter();
  ee.stdout = stdout;
  queueMicrotask(() => {
    for (const c of chunks) stdout.emit("data", Buffer.from(c));
    ee.emit("close", 0);
  });
  return ee;
}

/** Mock child that closes with a non-zero exit code (GCM not configured / cancelled). */
function fillExitNonZero(code = 1): MockChildProcess {
  const ee = makeMockChild();
  ee.stdout = new EventEmitter();
  queueMicrotask(() => ee.emit("close", code));
  return ee;
}

/** Mock child for `credential approve|reject` — no stdout output expected. */
function confirmSuccess(): MockChildProcess {
  const ee = makeMockChild();
  ee.stdout = new EventEmitter();
  queueMicrotask(() => ee.emit("close", 0));
  return ee;
}

function confirmExitNonZero(code = 7): MockChildProcess {
  const ee = makeMockChild();
  ee.stdout = new EventEmitter();
  queueMicrotask(() => ee.emit("close", code));
  return ee;
}

// argv classifiers — the resolver's silent peek adds `-c
// credential.interactive=false`; everything else goes through the
// baseline `-c credential.useHttpPath=true` flag.
const isSilentFill = (args: string[]): boolean =>
  args.includes("fill") && args.includes("credential.interactive=false");
const isInteractiveFill = (args: string[]): boolean =>
  args.includes("fill") && !args.includes("credential.interactive=false");
const isApprove = (args: string[]): boolean => args.includes("approve");
const isReject = (args: string[]): boolean => args.includes("reject");

interface RouteSpec {
  silentFill?: () => MockChildProcess;
  interactiveFill?: () => MockChildProcess;
  approve?: () => MockChildProcess;
  reject?: () => MockChildProcess;
}

/** Build a SpawnFactory that dispatches by argv shape. */
function router(spec: RouteSpec): SpawnFactory {
  return (call): MockChildProcess => {
    if (isApprove(call.args)) return (spec.approve ?? confirmSuccess)();
    if (isReject(call.args)) return (spec.reject ?? confirmSuccess)();
    if (isSilentFill(call.args))
      return (spec.silentFill ?? ((): MockChildProcess => fillExitNonZero()))();
    if (isInteractiveFill(call.args)) {
      return (spec.interactiveFill ?? ((): MockChildProcess => fillExitNonZero()))();
    }
    throw new Error(`unrouted spawn argv: ${JSON.stringify(call.args)}`);
  };
}

const ORIG_EXT_PAT = process.env.AZURE_DEVOPS_EXT_PAT;
const ORIG_PAT = process.env.AZURE_DEVOPS_PAT;
const ORIG_SAT = process.env.SYSTEM_ACCESSTOKEN;
const ORIG_CI = process.env.CI;
const ORIG_GLYPHS_NI = process.env.GLYPHS_NON_INTERACTIVE;
const ORIG_IS_TTY_DESC = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const ORIG_EMIT_WARNING = process.emitWarning.bind(process);

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    configurable: true,
    writable: true,
  });
}

function restoreTTY(): void {
  if (ORIG_IS_TTY_DESC !== undefined) {
    Object.defineProperty(process.stdin, "isTTY", ORIG_IS_TTY_DESC);
  } else {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
      writable: true,
    });
  }
}

let stderrSpy: ReturnType<typeof vi.spyOn> | null = null;
let stderrChunks: string[] = [];
const warnings: { msg: string; code?: string }[] = [];

beforeEach(() => {
  _resetAdoTokenCache();
  spawnCalls = [];
  spawnFactory = null;
  warnings.length = 0;
  stderrChunks = [];
  delete process.env.AZURE_DEVOPS_EXT_PAT;
  delete process.env.AZURE_DEVOPS_PAT;
  delete process.env.SYSTEM_ACCESSTOKEN;
  delete process.env.CI;
  delete process.env.GLYPHS_NON_INTERACTIVE;
  setTTY(true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown): boolean => {
    stderrChunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk as Buffer).toString("utf8"),
    );
    return true;
  }) as never);
  process.emitWarning = ((msg: unknown, opts?: unknown): void => {
    const code =
      typeof opts === "string"
        ? undefined
        : (((opts ?? {}) as { code?: string }).code ?? undefined);
    warnings.push(code === undefined ? { msg: String(msg) } : { msg: String(msg), code });
  }) as typeof process.emitWarning;
  vi.useRealTimers();
});

afterEach(() => {
  process.emitWarning = ORIG_EMIT_WARNING;
  stderrSpy?.mockRestore();
  stderrSpy = null;
  restoreTTY();
  if (ORIG_EXT_PAT === undefined) delete process.env.AZURE_DEVOPS_EXT_PAT;
  else process.env.AZURE_DEVOPS_EXT_PAT = ORIG_EXT_PAT;
  if (ORIG_PAT === undefined) delete process.env.AZURE_DEVOPS_PAT;
  else process.env.AZURE_DEVOPS_PAT = ORIG_PAT;
  if (ORIG_SAT === undefined) delete process.env.SYSTEM_ACCESSTOKEN;
  else process.env.SYSTEM_ACCESSTOKEN = ORIG_SAT;
  if (ORIG_CI === undefined) delete process.env.CI;
  else process.env.CI = ORIG_CI;
  if (ORIG_GLYPHS_NI === undefined) delete process.env.GLYPHS_NON_INTERACTIVE;
  else process.env.GLYPHS_NON_INTERACTIVE = ORIG_GLYPHS_NI;
});

describe("resolveDefaultAdoToken — env-var path", () => {
  it("returns AZURE_DEVOPS_EXT_PAT with source 'env' when set, never invoking git", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "envpat_extpat_123";
    const r = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(r).toEqual({ source: "env", token: "envpat_extpat_123" });
    expect(spawnCalls).toHaveLength(0);
  });

  it("falls back to AZURE_DEVOPS_PAT when AZURE_DEVOPS_EXT_PAT absent", async () => {
    process.env.AZURE_DEVOPS_PAT = "legacypat_456";
    const r = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(r).toEqual({ source: "env", token: "legacypat_456" });
    expect(spawnCalls).toHaveLength(0);
  });

  it("falls back to SYSTEM_ACCESSTOKEN when EXT_PAT and PAT absent", async () => {
    process.env.SYSTEM_ACCESSTOKEN = "pipeline_token_789";
    const r = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(r).toEqual({ source: "env", token: "pipeline_token_789" });
    expect(spawnCalls).toHaveLength(0);
  });

  it("prefers EXT_PAT over PAT and SYSTEM_ACCESSTOKEN", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "primary";
    process.env.AZURE_DEVOPS_PAT = "secondary";
    process.env.SYSTEM_ACCESSTOKEN = "tertiary";
    const r = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(r).toEqual({ source: "env", token: "primary" });
  });

  it("re-reads env on each call (does NOT cache env lookups)", async () => {
    spawnFactory = router({
      silentFill: () => fillSuccess(["username=u\npassword=fromgit\n"]),
    });
    const first = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(first).toEqual({ source: "git-credential", token: "fromgit", username: "u" });
    process.env.AZURE_DEVOPS_EXT_PAT = "envwins_midrun";
    const second = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(second).toEqual({ source: "env", token: "envwins_midrun" });
  });

  it("never spawns git when an env-var token is available (no silent peek either)", async () => {
    process.env.AZURE_DEVOPS_PAT = "envtok";
    spawnFactory = (): MockChildProcess => {
      throw new Error("spawn must not be called when env-var is set");
    };
    await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("resolveDefaultAdoToken — silent peek (warm cache, no popup)", () => {
  it("warm peek returns creds → git-credential source, no stderr, no interactive fill spawn", async () => {
    spawnFactory = router({
      silentFill: () =>
        fillSuccess(["protocol=https\nhost=dev.azure.com\nusername=u@x.com\npassword=eyJjwt\n\n"]),
    });
    const r = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(r).toEqual({ source: "git-credential", token: "eyJjwt", username: "u@x.com" });
    expect(spawnCalls).toHaveLength(1);
    expect(isSilentFill(spawnCalls[0]!.args)).toBe(true);
    expect(stderrChunks.join("")).toBe("");
  });

  it("silent peek argv contains credential.interactive=false AND env sets GCM_INTERACTIVE=Never", async () => {
    spawnFactory = router({
      silentFill: () => fillSuccess(["username=u\npassword=p\n"]),
    });
    await resolveDefaultAdoToken("MyOrg", "MyRepo");
    const call = spawnCalls[0]!;
    expect(call.args).toContain("credential.useHttpPath=true");
    expect(call.args).toContain("credential.interactive=false");
    expect(call.args).toContain("fill");
    expect(call.opts.env?.GCM_INTERACTIVE).toBe("Never");
  });

  it("silent peek stdin includes path=<org>/_git/<repo>", async () => {
    spawnFactory = router({
      silentFill: () => fillSuccess(["username=u\npassword=p\n"]),
    });
    await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(spawnCalls[0]!.stdin).toContain("protocol=https");
    expect(spawnCalls[0]!.stdin).toContain("host=dev.azure.com");
    expect(spawnCalls[0]!.stdin).toContain("path=MyOrg/_git/MyRepo");
  });
});

describe("resolveDefaultAdoToken — non-interactive guard (fail fast, don't hang)", () => {
  it("silent peek null + stdin non-TTY + no env PAT → throws FetchError with AZURE_DEVOPS_PAT remediation", async () => {
    setTTY(false);
    spawnFactory = router({ silentFill: () => fillExitNonZero() });
    let caught: unknown = null;
    try {
      await resolveDefaultAdoToken("MyOrg", "MyRepo");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FetchError);
    const msg = (caught as Error).message;
    expect(msg).toContain("AZURE_DEVOPS_PAT");
    expect(msg).toContain("dev.azure.com/MyOrg/MyRepo");
    expect(msg).toContain("git ls-remote");
    // MUST NOT attempt interactive fill (would hang on an unrenderable popup)
    expect(spawnCalls.some((c) => isInteractiveFill(c.args))).toBe(false);
  });

  it("silent peek null + CI=true (even on TTY) + no env PAT → throws FetchError", async () => {
    setTTY(true);
    process.env.CI = "true";
    spawnFactory = router({ silentFill: () => fillExitNonZero() });
    await expect(resolveDefaultAdoToken("MyOrg", "MyRepo")).rejects.toThrow(/AZURE_DEVOPS_PAT/);
    expect(spawnCalls.some((c) => isInteractiveFill(c.args))).toBe(false);
  });

  it("silent peek null + GLYPHS_NON_INTERACTIVE=1 (even on TTY) + no env PAT → throws FetchError", async () => {
    setTTY(true);
    process.env.GLYPHS_NON_INTERACTIVE = "1";
    spawnFactory = router({ silentFill: () => fillExitNonZero() });
    await expect(resolveDefaultAdoToken("MyOrg", "MyRepo")).rejects.toThrow(/AZURE_DEVOPS_PAT/);
    expect(spawnCalls.some((c) => isInteractiveFill(c.args))).toBe(false);
  });
});

describe("resolveDefaultAdoToken — interactive fallback (cold cache + TTY)", () => {
  it("silent peek null + TTY → 'Authenticating…' stderr + interactive fill spawned", async () => {
    setTTY(true);
    spawnFactory = router({
      silentFill: () => fillExitNonZero(),
      interactiveFill: () => fillSuccess(["username=user@example.com\npassword=tok123\n"]),
    });
    const r = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(r).toEqual({
      source: "git-credential",
      token: "tok123",
      username: "user@example.com",
    });
    const stderr = stderrChunks.join("");
    expect(stderr).toContain("[glyphs] Authenticating to dev.azure.com/MyOrg");
    expect(stderr).toContain("sign-in window");
    expect(spawnCalls.filter((c) => isSilentFill(c.args))).toHaveLength(1);
    expect(spawnCalls.filter((c) => isInteractiveFill(c.args))).toHaveLength(1);
  });

  it("interactive fill also fails → returns null and caches null (no re-spawn next call)", async () => {
    setTTY(true);
    spawnFactory = router({
      silentFill: () => fillExitNonZero(),
      interactiveFill: () => fillExitNonZero(),
    });
    const r1 = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(r1).toBeNull();
    const before = spawnCalls.length;
    const r2 = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(r2).toBeNull();
    expect(spawnCalls.length).toBe(before);
  });
});

describe("resolveDefaultAdoToken — caching", () => {
  it("caches a successful resolve within TTL (one silent peek for two calls)", async () => {
    spawnFactory = router({
      silentFill: () => fillSuccess(["username=u\npassword=cached_tok\n"]),
    });
    const first = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(first?.token).toBe("cached_tok");
    const before = spawnCalls.length;
    const second = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(second?.token).toBe("cached_tok");
    expect(spawnCalls.length).toBe(before);
  });

  it("re-spawns after the cache TTL elapses", async () => {
    let n = 0;
    spawnFactory = router({
      silentFill: () => {
        n++;
        const tag = n === 1 ? "first" : "second";
        return fillSuccess([`username=u\npassword=tok_${tag}\n`]);
      },
    });
    vi.useFakeTimers({ shouldAdvanceTime: false, now: Date.now() });
    try {
      const a = await resolveDefaultAdoToken("MyOrg", "MyRepo");
      expect(a?.token).toBe("tok_first");
      vi.setSystemTime(Date.now() + 61_000);
      const b = await resolveDefaultAdoToken("MyOrg", "MyRepo");
      expect(b?.token).toBe("tok_second");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keys cache on (org, repo) — different repos spawn independently", async () => {
    let n = 0;
    spawnFactory = router({
      silentFill: () => {
        n++;
        return fillSuccess([`username=u\npassword=tok_${n}\n`]);
      },
    });
    const a = await resolveDefaultAdoToken("OrgA", "RepoA");
    const b = await resolveDefaultAdoToken("OrgA", "RepoB");
    const c = await resolveDefaultAdoToken("OrgA", "RepoA");
    expect(a?.token).toBe("tok_1");
    expect(b?.token).toBe("tok_2");
    expect(c?.token).toBe("tok_1");
    expect(spawnCalls.filter((x) => isSilentFill(x.args))).toHaveLength(2);
  });

  it("keys cache on (org, repo) — different orgs spawn independently", async () => {
    let n = 0;
    spawnFactory = router({
      silentFill: () => {
        n++;
        return fillSuccess([`username=u\npassword=t${n}\n`]);
      },
    });
    await resolveDefaultAdoToken("OrgA", "Repo");
    await resolveDefaultAdoToken("OrgB", "Repo");
    expect(spawnCalls.filter((x) => isSilentFill(x.args))).toHaveLength(2);
  });
});

describe("resolveDefaultAdoToken — in-flight Promise dedup (pitfall 21)", () => {
  it("8 concurrent calls on a cold cache spawn `credential fill` exactly ONCE", async () => {
    // Without dedup, all 8 callers would bypass the cache check before
    // the first spawn completed and each spawn a GCM peek in parallel.
    setTTY(true);
    let outstanding = false;
    spawnFactory = router({
      silentFill: () => {
        if (outstanding) {
          throw new Error("concurrent silent-peek spawn — in-flight dedup is broken");
        }
        outstanding = true;
        const ee = makeMockChild();
        const stdout = new EventEmitter();
        ee.stdout = stdout;
        // Delay close so all 8 concurrent callers must share the in-flight Promise.
        setTimeout(() => {
          outstanding = false;
          stdout.emit("data", Buffer.from("username=u\npassword=tok\n"));
          ee.emit("close", 0);
        }, 20);
        return ee;
      },
    });
    const calls = Array.from({ length: 8 }, () => resolveDefaultAdoToken("MyOrg", "MyRepo"));
    const results = await Promise.all(calls);
    for (const r of results) {
      expect(r).toEqual({ source: "git-credential", token: "tok", username: "u" });
    }
    expect(spawnCalls.filter((c) => isSilentFill(c.args))).toHaveLength(1);
  });
});

describe("tryGitCredentialFill — interactive variant", () => {
  it("invokes git with the baseline credential-fill argv and returns {username, password}", async () => {
    spawnFactory = () =>
      fillSuccess(["protocol=https\nhost=dev.azure.com\nusername=foo\npassword=eyJsecretJwt\n\n"]);
    const r = await tryGitCredentialFill("MyOrg", "MyRepo");
    expect(r).toEqual({ username: "foo", password: "eyJsecretJwt" });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args).toEqual([
      "-c",
      "credential.useHttpPath=true",
      "credential",
      "fill",
    ]);
    expect(spawnCalls[0]!.opts.stdio).toEqual(["pipe", "pipe", "ignore"]);
    expect(spawnCalls[0]!.opts.windowsHide).toBe(true);
    // interactive variant inherits parent env unchanged (no `env` override)
    expect(spawnCalls[0]!.opts.env).toBeUndefined();
  });

  it("returns username='' when GCM omits the username= line (defensive)", async () => {
    spawnFactory = () => fillSuccess(["password=onlypass\n"]);
    const r = await tryGitCredentialFill("MyOrg", "MyRepo");
    expect(r).toEqual({ username: "", password: "onlypass" });
  });

  it("writes credential request to stdin with the org+repo path entry", async () => {
    spawnFactory = () => fillSuccess(["username=u\npassword=t\n"]);
    await tryGitCredentialFill("MyOrg", "MyRepo");
    const written = spawnCalls[0]!.stdin;
    expect(written).toContain("protocol=https");
    expect(written).toContain("host=dev.azure.com");
    // path=<org>/_git/<repo> is REQUIRED for GCM to resolve dev.azure.com
    // credentials; without it GCM throws "Cannot determine the organization
    // name". Pitfall 1.
    expect(written).toContain("path=MyOrg/_git/MyRepo");
  });

  it("returns null when git exits non-zero (GCM unconfigured / user cancelled)", async () => {
    spawnFactory = () => fillExitNonZero();
    const r = await tryGitCredentialFill("MyOrg", "MyRepo");
    expect(r).toBeNull();
  });

  it("returns null and does NOT throw when spawn throws ENOENT", async () => {
    spawnFactory = () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    };
    const r = await tryGitCredentialFill("MyOrg", "MyRepo");
    expect(r).toBeNull();
  });

  it("returns null when git emits an 'error' event", async () => {
    spawnFactory = (): MockChildProcess => {
      const ee = makeMockChild();
      queueMicrotask(() => ee.emit("error", new Error("EPERM")));
      return ee;
    };
    const r = await tryGitCredentialFill("MyOrg", "MyRepo");
    expect(r).toBeNull();
  });

  it("returns null when stdout has no password= line", async () => {
    spawnFactory = () => fillSuccess(["protocol=https\nhost=dev.azure.com\nusername=u\n\n"]);
    const r = await tryGitCredentialFill("MyOrg", "MyRepo");
    expect(r).toBeNull();
  });

  it("returns null when password= line is empty", async () => {
    spawnFactory = () => fillSuccess(["username=u\npassword=\n\n"]);
    const r = await tryGitCredentialFill("MyOrg", "MyRepo");
    expect(r).toBeNull();
  });

  it("does NOT validate token shape — opaque GCM responses accepted as-is", async () => {
    // PATs and Azure AD JWTs have wildly different shapes; the resolver
    // must NOT pattern-match the password. A random opaque blob should
    // round-trip unchanged.
    spawnFactory = () => fillSuccess(["username=u\npassword=opaque-garbage-not-a-jwt-or-pat\n"]);
    const r = await tryGitCredentialFill("MyOrg", "MyRepo");
    expect(r).toEqual({ username: "u", password: "opaque-garbage-not-a-jwt-or-pat" });
  });

  it("kills git and returns null on timeout", async () => {
    let killed = false;
    spawnFactory = (): MockChildProcess => {
      const ee = makeMockChild();
      ee.kill = vi.fn().mockImplementation(() => {
        killed = true;
        return true;
      });
      ee.stdout = new EventEmitter();
      return ee;
    };
    vi.useFakeTimers();
    try {
      const promise = tryGitCredentialFill("MyOrg", "MyRepo");
      await vi.advanceTimersByTimeAsync(5_000);
      const r = await promise;
      expect(r).toBeNull();
      expect(killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("gitCredentialApprove — happy path + failure modes", () => {
  it("spawns `git credential approve` with the full request on stdin; returns void", async () => {
    spawnFactory = () => confirmSuccess();
    const out = await gitCredentialApprove("MyOrg", "MyRepo", "u@x.com", "tokABC");
    expect(out).toBeUndefined();
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0]!;
    expect(call.args).toEqual(["-c", "credential.useHttpPath=true", "credential", "approve"]);
    expect(call.stdin).toContain("protocol=https");
    expect(call.stdin).toContain("host=dev.azure.com");
    expect(call.stdin).toContain("path=MyOrg/_git/MyRepo");
    // Round-trip the username — GCM keys per-cred entries on
    // (protocol, host, path, username); omitting it = silent no-op.
    expect(call.stdin).toContain("username=u@x.com");
    expect(call.stdin).toContain("password=tokABC");
    // Blank-line terminated request body
    expect(call.stdin).toMatch(/\n\n$/);
    expect(warnings).toHaveLength(0);
  });

  it("returns void and emits process.emitWarning EMPLOKE_GCM_APPROVE_FAILED on spawn ENOENT", async () => {
    spawnFactory = () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    };
    const out = await gitCredentialApprove("MyOrg", "MyRepo", "u", "p");
    expect(out).toBeUndefined();
    expect(warnings.some((w) => w.code === "EMPLOKE_GCM_APPROVE_FAILED")).toBe(true);
  });

  it("returns void and emits warning EMPLOKE_GCM_APPROVE_FAILED on non-zero exit code", async () => {
    spawnFactory = () => confirmExitNonZero(7);
    const out = await gitCredentialApprove("MyOrg", "MyRepo", "u", "p");
    expect(out).toBeUndefined();
    expect(warnings.some((w) => w.code === "EMPLOKE_GCM_APPROVE_FAILED")).toBe(true);
  });
});

describe("gitCredentialReject — happy path + failure modes", () => {
  it("spawns `git credential reject` with the full request on stdin; returns void", async () => {
    spawnFactory = () => confirmSuccess();
    const out = await gitCredentialReject("MyOrg", "MyRepo", "u@x.com", "tokABC");
    expect(out).toBeUndefined();
    expect(spawnCalls[0]!.args).toEqual([
      "-c",
      "credential.useHttpPath=true",
      "credential",
      "reject",
    ]);
    expect(spawnCalls[0]!.stdin).toContain("username=u@x.com");
    expect(spawnCalls[0]!.stdin).toContain("password=tokABC");
    expect(warnings).toHaveLength(0);
  });

  it("returns void and emits warning EMPLOKE_GCM_REJECT_FAILED on non-zero exit", async () => {
    spawnFactory = () => confirmExitNonZero(2);
    const out = await gitCredentialReject("MyOrg", "MyRepo", "u", "p");
    expect(out).toBeUndefined();
    expect(warnings.some((w) => w.code === "EMPLOKE_GCM_REJECT_FAILED")).toBe(true);
  });

  it("returns void and emits warning EMPLOKE_GCM_REJECT_FAILED on spawn ENOENT", async () => {
    spawnFactory = () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    };
    const out = await gitCredentialReject("MyOrg", "MyRepo", "u", "p");
    expect(out).toBeUndefined();
    expect(warnings.some((w) => w.code === "EMPLOKE_GCM_REJECT_FAILED")).toBe(true);
  });
});

describe("invalidateAdoTokenCache", () => {
  it("clears the in-process entry for that (org, repo); next resolve re-runs fill", async () => {
    let n = 0;
    spawnFactory = router({
      silentFill: () => {
        n++;
        return fillSuccess([`username=u\npassword=tok_${n}\n`]);
      },
    });
    const a = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(a?.token).toBe("tok_1");
    invalidateAdoTokenCache("MyOrg", "MyRepo");
    const b = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(b?.token).toBe("tok_2");
    expect(spawnCalls.filter((c) => isSilentFill(c.args))).toHaveLength(2);
  });

  it("only clears the targeted (org, repo) key; other entries remain cached", async () => {
    let n = 0;
    spawnFactory = router({
      silentFill: () => {
        n++;
        return fillSuccess([`username=u\npassword=t${n}\n`]);
      },
    });
    await resolveDefaultAdoToken("A", "R1");
    await resolveDefaultAdoToken("A", "R2");
    invalidateAdoTokenCache("A", "R1");
    const r2 = await resolveDefaultAdoToken("A", "R2");
    expect(r2?.token).toBe("t2");
    const r1 = await resolveDefaultAdoToken("A", "R1");
    expect(r1?.token).toBe("t3");
  });
});
