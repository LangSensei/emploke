import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for `ado-token.ts`. We mock `node:child_process.spawn` so the suite
 * is hermetic — never actually shells out to `git`. The mock is installed
 * at module-load time via `vi.mock` so the resolver picks it up on first
 * import. Mirrors the structure of `gh-token.test.ts`.
 */

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter | null;
  stdin: { write: (data: string, cb?: (err?: Error) => void) => void; end: () => void } | null;
  kill(signal?: string): boolean;
}

type SpawnFactory = () => MockChildProcess;

let spawnFactory: SpawnFactory | null = null;
let spawnSpy = vi.fn<(...args: unknown[]) => void>();
let stdinWrites: string[] = [];

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => {
    spawnSpy(...args);
    if (!spawnFactory) throw new Error("test forgot to install spawnFactory");
    return spawnFactory();
  },
}));

const { _resetAdoTokenCache, resolveDefaultAdoToken, tryGitCredentialFill } = await import(
  "../../src/fetcher/ado-token.js"
);

function makeMockChild(): MockChildProcess {
  const ee = new EventEmitter() as MockChildProcess;
  ee.stdout = null;
  ee.stdin = {
    write: vi.fn((data: string, cb?: (err?: Error) => void) => {
      stdinWrites.push(data);
      cb?.();
    }),
    end: vi.fn(),
  };
  ee.kill = vi.fn().mockReturnValue(true);
  return ee;
}

/**
 * Build a `git credential fill` mock that emits `chunks` on stdout, then
 * closes with `exitCode`. Both the data and the close are scheduled on the
 * same microtask after the resolver has had a chance to attach its
 * listeners.
 */
function makeFillMock(chunks: string[], exitCode: number): SpawnFactory {
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

const ORIG_EXT_PAT = process.env.AZURE_DEVOPS_EXT_PAT;
const ORIG_PAT = process.env.AZURE_DEVOPS_PAT;
const ORIG_SAT = process.env.SYSTEM_ACCESSTOKEN;

beforeEach(() => {
  _resetAdoTokenCache();
  spawnSpy = vi.fn();
  spawnFactory = null;
  stdinWrites = [];
  delete process.env.AZURE_DEVOPS_EXT_PAT;
  delete process.env.AZURE_DEVOPS_PAT;
  delete process.env.SYSTEM_ACCESSTOKEN;
  vi.useRealTimers();
});

afterEach(() => {
  if (ORIG_EXT_PAT === undefined) delete process.env.AZURE_DEVOPS_EXT_PAT;
  else process.env.AZURE_DEVOPS_EXT_PAT = ORIG_EXT_PAT;
  if (ORIG_PAT === undefined) delete process.env.AZURE_DEVOPS_PAT;
  else process.env.AZURE_DEVOPS_PAT = ORIG_PAT;
  if (ORIG_SAT === undefined) delete process.env.SYSTEM_ACCESSTOKEN;
  else process.env.SYSTEM_ACCESSTOKEN = ORIG_SAT;
});

describe("resolveDefaultAdoToken — env-var path", () => {
  it("returns AZURE_DEVOPS_EXT_PAT when set, never invoking git", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "envpat_extpat_123";
    const t = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(t).toBe("envpat_extpat_123");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("falls back to AZURE_DEVOPS_PAT when AZURE_DEVOPS_EXT_PAT absent", async () => {
    process.env.AZURE_DEVOPS_PAT = "legacypat_456";
    const t = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(t).toBe("legacypat_456");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("falls back to SYSTEM_ACCESSTOKEN when EXT_PAT and PAT absent", async () => {
    process.env.SYSTEM_ACCESSTOKEN = "pipeline_token_789";
    const t = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(t).toBe("pipeline_token_789");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("prefers EXT_PAT over PAT and SYSTEM_ACCESSTOKEN", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "primary";
    process.env.AZURE_DEVOPS_PAT = "secondary";
    process.env.SYSTEM_ACCESSTOKEN = "tertiary";
    const t = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(t).toBe("primary");
  });

  it("re-reads env on each call (does NOT cache env lookups)", async () => {
    spawnFactory = makeFillMock(["password=fromgit\n"], 0);
    expect(await resolveDefaultAdoToken("MyOrg", "MyRepo")).toBe("fromgit");
    process.env.AZURE_DEVOPS_EXT_PAT = "envwins_midrun";
    expect(await resolveDefaultAdoToken("MyOrg", "MyRepo")).toBe("envwins_midrun");
  });
});

describe("resolveDefaultAdoToken — git credential fill fallback", () => {
  it("invokes git with the credential-fill argv and reads password= from stdout", async () => {
    spawnFactory = makeFillMock(
      ["protocol=https\nhost=dev.azure.com\nusername=foo\npassword=eyJsecretJwt\n\n"],
      0,
    );
    const t = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(t).toBe("eyJsecretJwt");
    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(spawnSpy).toHaveBeenCalledWith(
      "git",
      ["-c", "credential.useHttpPath=true", "credential", "fill"],
      expect.objectContaining({
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      }),
    );
  });

  it("writes credential request to stdin with the org+repo path entry", async () => {
    spawnFactory = makeFillMock(["password=tok\n"], 0);
    await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(stdinWrites.length).toBeGreaterThan(0);
    const written = stdinWrites.join("");
    expect(written).toContain("protocol=https");
    expect(written).toContain("host=dev.azure.com");
    // path=<org>/_git/<repo> is REQUIRED for GCM to resolve dev.azure.com
    // credentials; without it GCM throws "Cannot determine the organization
    // name". Pitfall 1.
    expect(written).toContain("path=MyOrg/_git/MyRepo");
  });

  it("returns null when git exits non-zero (GCM unconfigured / user cancelled)", async () => {
    spawnFactory = makeFillMock([""], 1);
    const t = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(t).toBeNull();
  });

  it("returns null and does NOT throw when spawn throws ENOENT", async () => {
    spawnFactory = () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    };
    const t = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(t).toBeNull();
  });

  it("returns null when git emits an 'error' event", async () => {
    spawnFactory = () => {
      const ee = makeMockChild();
      queueMicrotask(() => ee.emit("error", new Error("EPERM")));
      return ee;
    };
    const t = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(t).toBeNull();
  });

  it("returns null when stdout has no password= line", async () => {
    spawnFactory = makeFillMock(["protocol=https\nhost=dev.azure.com\n\n"], 0);
    const t = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(t).toBeNull();
  });

  it("returns null when password= line is empty", async () => {
    spawnFactory = makeFillMock(["password=\n\n"], 0);
    const t = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(t).toBeNull();
  });

  it("does NOT validate token shape — opaque GCM responses accepted as-is", async () => {
    // PATs and Azure AD JWTs have wildly different shapes; the resolver
    // must NOT pattern-match the password. A random opaque blob should
    // round-trip unchanged.
    spawnFactory = makeFillMock(["password=opaque-garbage-not-a-jwt-or-pat\n"], 0);
    const t = await resolveDefaultAdoToken("MyOrg", "MyRepo");
    expect(t).toBe("opaque-garbage-not-a-jwt-or-pat");
  });

  it("kills git and returns null on timeout", async () => {
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
    const promise = tryGitCredentialFill("MyOrg", "MyRepo");
    await vi.advanceTimersByTimeAsync(5_000);
    const t = await promise;
    expect(t).toBeNull();
    expect(killed).toBe(true);
    vi.useRealTimers();
  });
});

describe("resolveDefaultAdoToken — caching", () => {
  it("caches a successful token within TTL (one spawn for two calls)", async () => {
    let spawned = 0;
    spawnFactory = () => {
      spawned++;
      return makeFillMock(["password=cached_tok\n"], 0)();
    };
    expect(await resolveDefaultAdoToken("MyOrg", "MyRepo")).toBe("cached_tok");
    expect(await resolveDefaultAdoToken("MyOrg", "MyRepo")).toBe("cached_tok");
    expect(spawned).toBe(1);
  });

  it("caches a null result so repeated calls don't re-spawn git", async () => {
    let spawned = 0;
    spawnFactory = () => {
      spawned++;
      return makeFillMock([""], 1)();
    };
    expect(await resolveDefaultAdoToken("MyOrg", "MyRepo")).toBeNull();
    expect(await resolveDefaultAdoToken("MyOrg", "MyRepo")).toBeNull();
    expect(spawned).toBe(1);
  });

  it("re-spawns after the cache TTL elapses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, now: Date.now() });
    let spawned = 0;
    spawnFactory = () => {
      spawned++;
      const tag = spawned === 1 ? "first" : "second";
      return makeFillMock([`password=tok_${tag}\n`], 0)();
    };
    expect(await resolveDefaultAdoToken("MyOrg", "MyRepo")).toBe("tok_first");

    vi.setSystemTime(Date.now() + 61_000);

    expect(await resolveDefaultAdoToken("MyOrg", "MyRepo")).toBe("tok_second");
    expect(spawned).toBe(2);
    vi.useRealTimers();
  });

  it("keys cache on (org, repo) — different repos spawn independently", async () => {
    // Pitfall 8: GCM may have different cached creds per dev.azure.com
    // repo. Caching only by host would return the wrong cred.
    let spawned = 0;
    spawnFactory = () => {
      spawned++;
      return makeFillMock(["password=tok\n"], 0)();
    };
    await resolveDefaultAdoToken("OrgA", "RepoA");
    await resolveDefaultAdoToken("OrgA", "RepoB");
    await resolveDefaultAdoToken("OrgA", "RepoA");
    expect(spawned).toBe(2);
  });

  it("keys cache on (org, repo) — different orgs spawn independently", async () => {
    let spawned = 0;
    spawnFactory = () => {
      spawned++;
      return makeFillMock(["password=tok\n"], 0)();
    };
    await resolveDefaultAdoToken("OrgA", "Repo");
    await resolveDefaultAdoToken("OrgB", "Repo");
    expect(spawned).toBe(2);
  });
});
