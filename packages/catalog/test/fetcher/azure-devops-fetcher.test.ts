import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mock `node:child_process.spawn` so the `git credential fill` fallback
 * in `ado-token.ts` never actually shells out. Without this, every test
 * that doesn't set one of the supported env vars would block for the
 * full 5s `SPAWN_TIMEOUT_MS` waiting for Git Credential Manager to
 * respond. The mock returns a child that immediately closes with a
 * non-zero exit, which `ado-token.ts` treats as "no credential
 * available" and caches as `null` — so subsequent calls are also fast.
 *
 * The auth-resolution behaviour itself (env precedence, caching,
 * credential-fill parsing) is covered exhaustively by
 * `ado-token.test.ts`; this file's mock just keeps the fetcher tests
 * hermetic.
 */
vi.mock("node:child_process", () => ({
  spawn: () => {
    const ee = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter | null;
      stdin: { write: (data: string, cb?: () => void) => void; end: () => void } | null;
      kill: (signal?: string) => boolean;
    };
    ee.stdout = new EventEmitter();
    ee.stdin = {
      write: (_d, cb) => cb?.(),
      end: () => {},
    };
    ee.kill = () => true;
    queueMicrotask(() => ee.emit("close", 1));
    return ee;
  },
}));

const { AzureDevOpsFetcher, defaultFetcherRegistry, FetchError, parseOrigin } = await import(
  "../../src/fetcher/index.js"
);

/**
 * `AzureDevOpsFetcher` tests focused on the credential-resolution layer:
 * token source attribution under the env / git-credential-fill /
 * anonymous branches, a regression guard that token bytes never reach
 * `FetchError.message` on non-2xx upstream, and tree / file URL
 * composition. Mirrors `github-fetcher.test.ts`.
 *
 * Strategy: stub `globalThis.fetch` so the network is never hit. We
 * capture headers / URLs off the request and assert directly. The token
 * resolution layer is short-circuited by setting one of the supported
 * env vars; the spawn-based fallback is exercised in `ado-token.test.ts`.
 */

const ORIG_FETCH = globalThis.fetch;
const ORIG_EXT_PAT = process.env.AZURE_DEVOPS_EXT_PAT;
const ORIG_PAT = process.env.AZURE_DEVOPS_PAT;
const ORIG_SAT = process.env.SYSTEM_ACCESSTOKEN;

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  delete process.env.AZURE_DEVOPS_EXT_PAT;
  delete process.env.AZURE_DEVOPS_PAT;
  delete process.env.SYSTEM_ACCESSTOKEN;
  // Reset the ado-token cache so a stale entry from another test doesn't
  // cross-pollute. Reaching into the module directly is intentional —
  // the helper is package-internal (NOT exported from the index barrel).
  const mod = await import("../../src/fetcher/ado-token.js");
  mod._resetAdoTokenCache();
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  if (ORIG_EXT_PAT === undefined) delete process.env.AZURE_DEVOPS_EXT_PAT;
  else process.env.AZURE_DEVOPS_EXT_PAT = ORIG_EXT_PAT;
  if (ORIG_PAT === undefined) delete process.env.AZURE_DEVOPS_PAT;
  else process.env.AZURE_DEVOPS_PAT = ORIG_PAT;
  if (ORIG_SAT === undefined) delete process.env.SYSTEM_ACCESSTOKEN;
  else process.env.SYSTEM_ACCESSTOKEN = ORIG_SAT;
});

function stubFetchReturning404(): void {
  fetchSpy = vi.fn(async () => new Response("forbidden", { status: 404, statusText: "Not Found" }));
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
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
    // The base64-encoded form of the Basic header value must also be
    // absent — defends against accidentally including the rendered
    // Authorization header in an error message.
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
  it("hits Items API with subpath + relPath joined, full path URL-encoded as query value", async () => {
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
    // Pitfall 3: encodeURIComponent on the whole path encodes the leading
    // "/" as %2F. That IS what the ADO Items API expects.
    expect(capturedUrl).toBe(
      "https://dev.azure.com/MyOrg/MyProject/_apis/git/repositories/MyRepo/items" +
        "?path=%2Fskills%2Fx%2FSKILL.md&api-version=7.1",
    );
    expect(captured.headers.get("accept")).toBe("application/octet-stream");
  });

  it("uses the origin's subpath directly when relPath is empty (mcp single-file)", async () => {
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
    // Pitfall 2: project name may contain spaces (e.g. "O365 Core").
    // Must decode on parse and re-encode on URL construction.
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
    // 1 listing + 2 blob fetches. Tree entries were filtered before fetch.
    expect(urls).toHaveLength(3);
    expect(urls.some((u) => /path=%2Fskills%2Fx&/.test(u))).toBe(false);
    expect(urls.some((u) => /path=%2Fskills%2Fx%2Flib&/.test(u))).toBe(false);
  });

  it("falls back to single-file fetch when listing returns an empty value array", async () => {
    // Per §4.3 pitfall: ADO returns `value: []` (not 404) when the
    // scopePath names a file rather than a directory. The fetcher must
    // fall back to a direct file fetch and yield as basename.
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

describe("AzureDevOpsFetcher — scheme + registry wiring", () => {
  it("scheme is 'azure-devops' and matches the parser's ParsedOrigin tag", () => {
    // Pitfall 9: AzureDevOpsFetcher.scheme MUST equal "azure-devops" to
    // match ParsedOrigin.scheme so FetcherRegistry.resolve dispatches
    // correctly.
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
