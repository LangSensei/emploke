import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `AzureDevOpsFetcher` tests. Mocks both:
 *
 *   - `node:child_process.spawn` so the resolver / approve / reject paths
 *     in `ado-token.ts` never actually shell out to `git`. The factory
 *     dispatches by argv shape (silent fill / interactive fill / approve
 *     / reject) so a single mock covers the full three-step protocol.
 *
 *   - `globalThis.fetch` so HTTP traffic is captured per-test without
 *     hitting the real ADO REST API.
 *
 * The auth-resolution behaviour itself (env precedence, silent peek,
 * non-interactive guard, in-flight Promise dedup, approve/reject
 * helpers) is covered exhaustively in `ado-token.test.ts`; this file
 * focuses on the fetcher's three-step protocol surface (approve on 2xx,
 * reject + invalidate on 401/403, no-op on env / anonymous / 404 / 5xx)
 * plus tree-mode pre-warm (single resolve across all workers).
 *
 * `process.stdin.isTTY` is also stubbed because the resolver's
 * cold-cache path branches on it; we default to TTY=true in `beforeEach`
 * so anonymous-source tests (silent fail + interactive fail) take the
 * "interactive returns null → cache null → no Authorization header" path
 * rather than throwing the non-TTY escape-hatch error.
 */

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter | null;
  stdin: { write: (data: string, cb?: (err?: Error) => void) => boolean; end: () => void } | null;
  kill(signal?: string): boolean;
}

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: Record<string, unknown>;
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
      opts: (opts ?? {}) as Record<string, unknown>,
      stdin: "",
    };
    spawnCalls.push(call);
    const child = spawnFactory(call);
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

const { AzureDevOpsFetcher, defaultFetcherRegistry, FetchError, parseOrigin } = await import(
  "../../src/fetcher/index.js"
);
const { _resetAdoTokenCache } = await import("../../src/fetcher/ado-token.js");

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

function fillExitNonZero(code = 1): MockChildProcess {
  const ee = makeMockChild();
  ee.stdout = new EventEmitter();
  queueMicrotask(() => ee.emit("close", code));
  return ee;
}

function confirmSuccess(): MockChildProcess {
  const ee = makeMockChild();
  ee.stdout = new EventEmitter();
  queueMicrotask(() => ee.emit("close", 0));
  return ee;
}

const isSilentFill = (a: string[]): boolean =>
  a.includes("fill") && a.includes("credential.interactive=false");
const isInteractiveFill = (a: string[]): boolean =>
  a.includes("fill") && !a.includes("credential.interactive=false");
const isApprove = (a: string[]): boolean => a.includes("approve");
const isReject = (a: string[]): boolean => a.includes("reject");

interface RouteSpec {
  silentFill?: () => MockChildProcess;
  interactiveFill?: () => MockChildProcess;
  approve?: () => MockChildProcess;
  reject?: () => MockChildProcess;
}

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

/**
 * Anonymous-path mock: silent peek fails, interactive fill fails (with
 * TTY=true so the resolver takes the interactive branch instead of
 * throwing the non-interactive escape-hatch). Result: resolver returns
 * `null` (no cred), fetcher proceeds anonymously, no approve/reject.
 */
const ANON_ROUTER: SpawnFactory = router({
  silentFill: () => fillExitNonZero(),
  interactiveFill: () => fillExitNonZero(),
});

const ORIG_FETCH = globalThis.fetch;
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

let fetchSpy: ReturnType<typeof vi.fn>;
let stderrSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  _resetAdoTokenCache();
  spawnCalls = [];
  // Default to the anonymous-path mock so tests that don't set env vars
  // or override the factory don't crash with "unrouted spawn argv". They
  // get a null credential — same as the iter-1 behaviour where every
  // resolveDefaultAdoToken returned null when GCM was unconfigured.
  spawnFactory = ANON_ROUTER;
  delete process.env.AZURE_DEVOPS_EXT_PAT;
  delete process.env.AZURE_DEVOPS_PAT;
  delete process.env.SYSTEM_ACCESSTOKEN;
  delete process.env.CI;
  delete process.env.GLYPHS_NON_INTERACTIVE;
  setTTY(true); // default: pretend we're on a real terminal
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  process.emitWarning = (() => {}) as typeof process.emitWarning;
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
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

function stubFetchReturning404(): void {
  fetchSpy = vi.fn(async () => new Response("forbidden", { status: 404, statusText: "Not Found" }));
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
}

/**
 * Flush queued microtasks + macrotasks so fire-and-forget spawns
 * (approve / reject) have a chance to enqueue their child-process
 * objects into `spawnCalls` before the test asserts on them. `setImmediate`
 * runs after all current microtasks, which is enough for our needs.
 */
async function flushFireAndForget(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const SAMPLE_URI = "https://dev.azure.com/MyOrg/MyProject/_git/MyRepo?path=/skills/x";

async function runFetcher(): Promise<string | null> {
  const f = new AzureDevOpsFetcher();
  const iter = f.fetchTree(SAMPLE_URI);
  try {
    for await (const _ of iter) {
      // unreachable in error-path tests
    }
    return null;
  } catch (e) {
    if (e instanceof FetchError) return e.message;
    throw e;
  }
}

async function runFetchFile(): Promise<string | null> {
  const f = new AzureDevOpsFetcher();
  try {
    await f.fetchFile(SAMPLE_URI, "SKILL.md");
    return null;
  } catch (e) {
    if (e instanceof FetchError) return e.message;
    throw e;
  }
}

describe("AzureDevOpsFetcher — Authorization header from env var", () => {
  it("attaches Basic-with-empty-username header derived from AZURE_DEVOPS_EXT_PAT", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "extpat_envvalue123";
    const captured = { headers: new Headers() };
    fetchSpy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.headers) captured.headers = new Headers(init.headers);
      return new Response("nope", { status: 404, statusText: "Not Found" });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await runFetcher();
    const expected = `Basic ${Buffer.from(":extpat_envvalue123", "utf8").toString("base64")}`;
    expect(captured.headers.get("authorization")).toBe(expected);
  });

  it("attaches Basic header when AZURE_DEVOPS_PAT is set (EXT_PAT absent)", async () => {
    process.env.AZURE_DEVOPS_PAT = "legacypat_value";
    const captured = { headers: new Headers() };
    fetchSpy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.headers) captured.headers = new Headers(init.headers);
      return new Response("nope", { status: 404, statusText: "Not Found" });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await runFetcher();
    const expected = `Basic ${Buffer.from(":legacypat_value", "utf8").toString("base64")}`;
    expect(captured.headers.get("authorization")).toBe(expected);
  });

  it("attaches Basic header when SYSTEM_ACCESSTOKEN is set (EXT_PAT + PAT absent)", async () => {
    process.env.SYSTEM_ACCESSTOKEN = "pipeline_token_jwt";
    const captured = { headers: new Headers() };
    fetchSpy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.headers) captured.headers = new Headers(init.headers);
      return new Response("nope", { status: 404, statusText: "Not Found" });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await runFetcher();
    const expected = `Basic ${Buffer.from(":pipeline_token_jwt", "utf8").toString("base64")}`;
    expect(captured.headers.get("authorization")).toBe(expected);
  });

  it("uses Basic (never Bearer) — accepts both PATs and Azure AD JWTs", async () => {
    // Pitfall 4: ADO accepts both PATs and JWTs via the SAME Basic auth
    // header (with an empty username). The fetcher must never switch to
    // Bearer based on token shape.
    process.env.AZURE_DEVOPS_EXT_PAT = "eyJrandomLookingJwtPayload";
    const captured = { headers: new Headers() };
    fetchSpy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.headers) captured.headers = new Headers(init.headers);
      return new Response("nope", { status: 404, statusText: "Not Found" });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await runFetcher();
    const auth = captured.headers.get("authorization") ?? "";
    expect(auth.startsWith("Basic ")).toBe(true);
    expect(auth.startsWith("Bearer ")).toBe(false);
  });
});

describe("AzureDevOpsFetcher — token never leaks into FetchError", () => {
  it("HTTP error message does NOT contain the token bytes", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "ado_supersecret_DO_NOT_LEAK_424242";
    stubFetchReturning404();

    const msg = await runFetcher();
    expect(msg).not.toBeNull();
    expect(msg!).toMatch(/404/);
    expect(msg!).not.toContain("ado_supersecret_DO_NOT_LEAK_424242");
    expect(msg!).not.toContain("supersecret");
    const b64 = Buffer.from(":ado_supersecret_DO_NOT_LEAK_424242", "utf8").toString("base64");
    expect(msg!).not.toContain(b64);
  });

  it("network error message does NOT contain the token bytes", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "ado_anothersecret_KEEP_HIDDEN_999";
    fetchSpy = vi.fn(async () => {
      throw new Error("ECONNREFUSED to dev.azure.com");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const msg = await runFetcher();
    expect(msg).not.toBeNull();
    expect(msg!).toMatch(/network error/i);
    expect(msg!).not.toContain("ado_anothersecret_KEEP_HIDDEN_999");
    expect(msg!).not.toContain("anothersecret");
  });
});

describe("AzureDevOpsFetcher.fetchFile — Items API URL composition", () => {
  it("hits Items API with subpath + relPath joined, full path URL-encoded", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "pat";
    let capturedUrl = "";
    const captured = { headers: new Headers() };
    fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      if (init?.headers) captured.headers = new Headers(init.headers);
      return new Response("# hello\n", { status: 200, statusText: "OK" });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const f = new AzureDevOpsFetcher();
    const buf = await f.fetchFile(SAMPLE_URI, "SKILL.md");
    expect(buf.toString("utf8")).toBe("# hello\n");
    expect(capturedUrl).toBe(
      "https://dev.azure.com/MyOrg/MyProject/_apis/git/repositories/MyRepo/items" +
        "?path=%2Fskills%2Fx%2FSKILL.md&api-version=7.1",
    );
    expect(captured.headers.get("accept")).toBe("application/octet-stream");
  });

  it("uses the origin's subpath directly when relPath is empty (mcp single-file)", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "pat";
    let capturedUrl = "";
    fetchSpy = vi.fn(async (url: string | URL) => {
      capturedUrl = String(url);
      return new Response("{}\n", { status: 200, statusText: "OK" });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const f = new AzureDevOpsFetcher();
    const buf = await f.fetchFile(
      "https://dev.azure.com/MyOrg/MyProject/_git/MyRepo?path=/mcps/foo.json",
      "",
    );
    expect(buf.toString("utf8")).toBe("{}\n");
    expect(capturedUrl).toBe(
      "https://dev.azure.com/MyOrg/MyProject/_apis/git/repositories/MyRepo/items" +
        "?path=%2Fmcps%2Ffoo.json&api-version=7.1",
    );
  });

  it("URL-encodes a project name containing spaces", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "pat";
    let capturedUrl = "";
    fetchSpy = vi.fn(async (url: string | URL) => {
      capturedUrl = String(url);
      return new Response("ok", { status: 200, statusText: "OK" });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const f = new AzureDevOpsFetcher();
    await f.fetchFile(
      "https://dev.azure.com/O365Exchange/O365%20Core/_git/M365Bestla?path=/.claude/skills/bestla-pr-review",
      "SKILL.md",
    );
    expect(capturedUrl).toBe(
      "https://dev.azure.com/O365Exchange/O365%20Core/_apis/git/repositories/M365Bestla/items" +
        "?path=%2F.claude%2Fskills%2Fbestla-pr-review%2FSKILL.md&api-version=7.1",
    );
  });

  it("rejects relPath starting with /", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "pat";
    fetchSpy = vi.fn(async () => new Response("never", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const f = new AzureDevOpsFetcher();
    await expect(f.fetchFile(SAMPLE_URI, "/SKILL.md")).rejects.toThrow(FetchError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("FetchError on Items API 404 does NOT contain the token bytes", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "ado_contents_secret_DO_NOT_LEAK_777";
    fetchSpy = vi.fn(
      async () => new Response("not found", { status: 404, statusText: "Not Found" }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const msg = await runFetchFile();
    expect(msg).not.toBeNull();
    expect(msg!).toMatch(/404/);
    expect(msg!).not.toContain("ado_contents_secret_DO_NOT_LEAK_777");
    expect(msg!).not.toContain("contents_secret");
  });
});

describe("AzureDevOpsFetcher.fetchTree — Items recursive listing + fan-out", () => {
  type Route =
    | { kind: "json"; body: unknown; status?: number }
    | { kind: "raw"; body: string | Buffer; status?: number }
    | { kind: "status"; status: number; statusText?: string };

  function routeFetch(routes: { match: RegExp; route: Route }[]): {
    spy: ReturnType<typeof vi.fn>;
    urls: string[];
  } {
    const urls: string[] = [];
    const spy = vi.fn(async (url: string | URL) => {
      const u = String(url);
      urls.push(u);
      const hit = routes.find(({ match }) => match.test(u));
      if (!hit) return new Response("unmatched", { status: 599, statusText: "Unmatched" });
      const { route } = hit;
      if (route.kind === "json") {
        return new Response(JSON.stringify(route.body), {
          status: route.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (route.kind === "raw") {
        return new Response(route.body, { status: route.status ?? 200 });
      }
      return new Response("err", { status: route.status, statusText: route.statusText ?? "Err" });
    });
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;
    return { spy, urls };
  }

  async function collect(uri: string): Promise<{ relPath: string; content: string }[]> {
    const f = new AzureDevOpsFetcher();
    const out: { relPath: string; content: string }[] = [];
    for await (const e of f.fetchTree(uri)) {
      out.push({ relPath: e.relPath, content: e.content.toString("utf8") });
    }
    return out;
  }

  it("lists tree at scopePath, fans out parallel Items fetches, filters blobs only", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "pat";
    const { urls } = routeFetch([
      {
        match: /scopePath=.*recursionLevel=Full/,
        route: {
          kind: "json",
          body: {
            value: [
              { path: "/skills/x", gitObjectType: "tree", objectId: "0" },
              { path: "/skills/x/SKILL.md", gitObjectType: "blob", objectId: "1" },
              { path: "/skills/x/lib", gitObjectType: "tree", objectId: "2" },
              { path: "/skills/x/lib/util.ts", gitObjectType: "blob", objectId: "3" },
            ],
          },
        },
      },
      {
        match: /path=%2Fskills%2Fx%2FSKILL\.md&api-version/,
        route: { kind: "raw", body: "# skill x\n" },
      },
      {
        match: /path=%2Fskills%2Fx%2Flib%2Futil\.ts&api-version/,
        route: { kind: "raw", body: "export const x = 1;\n" },
      },
    ]);

    const out = await collect(SAMPLE_URI);

    expect(out.map((e) => e.relPath).sort()).toEqual(["SKILL.md", "lib/util.ts"]);
    expect(out.find((e) => e.relPath === "SKILL.md")?.content).toBe("# skill x\n");
    expect(out.find((e) => e.relPath === "lib/util.ts")?.content).toBe("export const x = 1;\n");
    expect(urls).toHaveLength(3);
    expect(urls.some((u) => /path=%2Fskills%2Fx&/.test(u))).toBe(false);
    expect(urls.some((u) => /path=%2Fskills%2Fx%2Flib&/.test(u))).toBe(false);
  });

  it("falls back to single-file fetch when listing returns an empty value array", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "pat";
    routeFetch([
      {
        match: /scopePath=.*recursionLevel=Full/,
        route: { kind: "json", body: { value: [] } },
      },
      {
        match: /path=%2Fmcps%2Ffoo\.json&api-version/,
        route: { kind: "raw", body: '{"name":"foo"}' },
      },
    ]);

    const out = await collect(
      "https://dev.azure.com/MyOrg/MyProject/_git/MyRepo?path=/mcps/foo.json",
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.relPath).toBe("foo.json");
    expect(out[0]?.content).toBe('{"name":"foo"}');
  });

  it("throws FetchError when listing has blobs but none under subpath", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "pat";
    routeFetch([
      {
        match: /scopePath=.*recursionLevel=Full/,
        route: {
          kind: "json",
          body: {
            value: [{ path: "/skills/y/SKILL.md", gitObjectType: "blob", objectId: "1" }],
          },
        },
      },
    ]);

    const f = new AzureDevOpsFetcher();
    await expect(async () => {
      for await (const _ of f.fetchTree(SAMPLE_URI)) {
        // unreachable
      }
    }).rejects.toThrow(/matched no blobs/);
  });

  it("FetchError on per-blob 404 does NOT contain the token bytes", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "ado_blob_secret_KEEP_HIDDEN_555";
    routeFetch([
      {
        match: /scopePath=.*recursionLevel=Full/,
        route: {
          kind: "json",
          body: {
            value: [{ path: "/skills/x/SKILL.md", gitObjectType: "blob", objectId: "1" }],
          },
        },
      },
      {
        match: /path=%2Fskills%2Fx%2FSKILL\.md&api-version/,
        route: { kind: "status", status: 404, statusText: "Not Found" },
      },
    ]);

    const f = new AzureDevOpsFetcher();
    let msg: string | null = null;
    try {
      for await (const _ of f.fetchTree(SAMPLE_URI)) {
        // unreachable
      }
    } catch (e) {
      if (e instanceof FetchError) msg = e.message;
      else throw e;
    }
    expect(msg).not.toBeNull();
    expect(msg!).toMatch(/404/);
    expect(msg!).not.toContain("ado_blob_secret_KEEP_HIDDEN_555");
    expect(msg!).not.toContain("blob_secret");
  });
});

describe("AzureDevOpsFetcher — three-step git credential helper protocol", () => {
  /** Build a spawn router that uses git-credential as the source (silent peek succeeds). */
  function gitCredentialRouter(): void {
    spawnFactory = router({
      silentFill: () =>
        fillSuccess(["protocol=https\nhost=dev.azure.com\nusername=u@x.com\npassword=eyJtok\n\n"]),
    });
  }

  it("calls gitCredentialApprove on 2xx via git-credential source (fetchFile)", async () => {
    gitCredentialRouter();
    fetchSpy = vi.fn(async () => new Response("# ok\n", { status: 200, statusText: "OK" }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const f = new AzureDevOpsFetcher();
    await f.fetchFile(SAMPLE_URI, "SKILL.md");
    await flushFireAndForget();

    const approveCalls = spawnCalls.filter((c) => isApprove(c.args));
    expect(approveCalls).toHaveLength(1);
    const stdin = approveCalls[0]!.stdin;
    expect(stdin).toContain("username=u@x.com");
    expect(stdin).toContain("password=eyJtok");
    expect(stdin).toContain("path=MyOrg/_git/MyRepo");
    expect(spawnCalls.filter((c) => isReject(c.args))).toHaveLength(0);
  });

  it("calls gitCredentialReject + invalidateAdoTokenCache on 401 via git-credential source", async () => {
    gitCredentialRouter();
    fetchSpy = vi.fn(async () => new Response("nope", { status: 401, statusText: "Unauthorized" }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await runFetchFile();
    await flushFireAndForget();

    const rejectCalls = spawnCalls.filter((c) => isReject(c.args));
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]!.stdin).toContain("username=u@x.com");
    expect(rejectCalls[0]!.stdin).toContain("password=eyJtok");
    expect(spawnCalls.filter((c) => isApprove(c.args))).toHaveLength(0);

    // invalidateAdoTokenCache cleared the cache: next resolve re-runs silent peek.
    const silentBefore = spawnCalls.filter((c) => isSilentFill(c.args)).length;
    fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    gitCredentialRouter(); // re-arm
    const f = new AzureDevOpsFetcher();
    await f.fetchFile(SAMPLE_URI, "SKILL.md");
    const silentAfter = spawnCalls.filter((c) => isSilentFill(c.args)).length;
    expect(silentAfter).toBeGreaterThan(silentBefore);
  });

  it("calls gitCredentialReject on 403 via git-credential source", async () => {
    gitCredentialRouter();
    fetchSpy = vi.fn(async () => new Response("nope", { status: 403, statusText: "Forbidden" }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    await runFetchFile();
    await flushFireAndForget();
    expect(spawnCalls.filter((c) => isReject(c.args))).toHaveLength(1);
  });

  it("does NOT call reject on 404 (wrong-path is not an auth failure)", async () => {
    gitCredentialRouter();
    fetchSpy = vi.fn(
      async () => new Response("not found", { status: 404, statusText: "Not Found" }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    await runFetchFile();
    await flushFireAndForget();
    expect(spawnCalls.filter((c) => isReject(c.args))).toHaveLength(0);
    expect(spawnCalls.filter((c) => isApprove(c.args))).toHaveLength(0);
  });

  it("does NOT call reject on 500 (server-side failure is not an auth failure)", async () => {
    gitCredentialRouter();
    fetchSpy = vi.fn(
      async () => new Response("boom", { status: 500, statusText: "Internal Server Error" }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    await runFetchFile();
    await flushFireAndForget();
    expect(spawnCalls.filter((c) => isReject(c.args))).toHaveLength(0);
    expect(spawnCalls.filter((c) => isApprove(c.args))).toHaveLength(0);
  });

  it("does NOT call approve/reject when source is env (any status code)", async () => {
    process.env.AZURE_DEVOPS_EXT_PAT = "env_pat";
    // Switch spawnFactory to throw so any git invocation explodes — env
    // source MUST NOT spawn git at all.
    spawnFactory = (): MockChildProcess => {
      throw new Error("env-source path must not spawn git");
    };
    for (const status of [200, 401, 403, 404, 500]) {
      fetchSpy = vi.fn(async () => new Response("x", { status }));
      globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
      await runFetchFile();
      await flushFireAndForget();
    }
    expect(spawnCalls).toHaveLength(0);
  });

  it("does NOT call approve/reject when source is anonymous (interactive fill also fails)", async () => {
    // Default spawnFactory (ANON_ROUTER) returns failure for both silent
    // and interactive fills → resolver returns null → fetcher proceeds
    // anonymously → no Authorization header → no approve/reject.
    const captured = { headers: new Headers() };
    fetchSpy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.headers) captured.headers = new Headers(init.headers);
      return new Response("ok", { status: 200, statusText: "OK" });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const f = new AzureDevOpsFetcher();
    await f.fetchFile(SAMPLE_URI, "SKILL.md");
    await flushFireAndForget();

    expect(captured.headers.get("authorization")).toBeNull();
    expect(spawnCalls.filter((c) => isApprove(c.args))).toHaveLength(0);
    expect(spawnCalls.filter((c) => isReject(c.args))).toHaveLength(0);
  });
});

describe("AzureDevOpsFetcher.fetchTree — single resolve across all workers", () => {
  it("with 10 blobs + cold cache, `resolveDefaultAdoToken` runs silent peek exactly ONCE", async () => {
    // git-credential source — silent peek succeeds with a stable cred.
    spawnFactory = router({
      silentFill: () =>
        fillSuccess(["protocol=https\nhost=dev.azure.com\nusername=u@x.com\npassword=eyJtok\n\n"]),
    });

    const entries = Array.from({ length: 10 }, (_, i) => ({
      path: `/skills/x/f${i}.md`,
      gitObjectType: "blob",
      objectId: String(i),
    }));
    fetchSpy = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (/scopePath=/.test(u)) {
        return new Response(JSON.stringify({ value: entries }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("blob bytes", { status: 200, statusText: "OK" });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const f = new AzureDevOpsFetcher();
    const collected: string[] = [];
    for await (const e of f.fetchTree(SAMPLE_URI)) {
      collected.push(e.relPath);
    }
    await flushFireAndForget();

    expect(collected).toHaveLength(10);
    // Without the pre-warm + in-flight dedup, the 8 concurrent workers
    // would each call resolveDefaultAdoToken → 8 silent-fill spawns.
    expect(spawnCalls.filter((c) => isSilentFill(c.args))).toHaveLength(1);
    expect(spawnCalls.filter((c) => isInteractiveFill(c.args))).toHaveLength(0);
    // 1 listing + 10 blob fetches = 11 successful HTTP responses
    // → 11 approve fire-and-forgets.
    expect(spawnCalls.filter((c) => isApprove(c.args))).toHaveLength(11);
    expect(spawnCalls.filter((c) => isReject(c.args))).toHaveLength(0);
  });
});

describe("AzureDevOpsFetcher — scheme + registry wiring", () => {
  it("scheme is 'azure-devops' and matches the parser's ParsedOrigin tag", () => {
    const f = new AzureDevOpsFetcher();
    expect(f.scheme).toBe("azure-devops");
    const origin = parseOrigin(SAMPLE_URI);
    expect(origin.scheme).toBe("azure-devops");
  });

  it("is registered in defaultFetcherRegistry()", () => {
    const reg = defaultFetcherRegistry();
    const f = reg.get("azure-devops");
    expect(f).toBeInstanceOf(AzureDevOpsFetcher);
  });
});
