import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchError, GitHubFetcher } from "../../src/fetcher/index.js";

/**
 * `GitHubFetcher` tests focused on the credential-resolution layer:
 * token source attribution under the env / gh / anonymous branches,
 * and a regression guard that token bytes never reach
 * `FetchError.message` on non-2xx upstream. Tarball extraction is
 * covered by the live install integration tests rather than
 * re-implemented here against a stubbed gunzip stream.
 *
 * Strategy: stub `globalThis.fetch` so the network is never hit. We capture
 * the headers off the request and assert directly. No tarball parsing path
 * runs because we make `response.ok = false`, which short-circuits the
 * fetcher to throw `FetchError` before opening the body stream.
 */

const ORIG_FETCH = globalThis.fetch;
const ORIG_GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORIG_GH_TOKEN = process.env.GH_TOKEN;

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  // Reset the gh-token cache so a stale entry from another test doesn't
  // cross-pollute. Reaching into the module directly is intentional —
  // the helper is package-internal.
  const mod = await import("../../src/fetcher/gh-token.js");
  mod._resetGhTokenCache();
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  if (ORIG_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = ORIG_GITHUB_TOKEN;
  if (ORIG_GH_TOKEN === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = ORIG_GH_TOKEN;
});

function stubFetchReturning404(): Headers {
  const captured = { headers: new Headers() };
  fetchSpy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    if (init?.headers) {
      captured.headers = new Headers(init.headers);
    }
    return new Response("forbidden", { status: 404, statusText: "Not Found" });
  });
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  return captured.headers;
}

async function runFetcher(): Promise<string | null> {
  const f = new GitHubFetcher();
  const iter = f.fetchTree("https://github.com/owner/repo/tree/main");
  try {
    // Pull one entry to drive the request. We expect the iterator to throw
    // a FetchError because the stubbed response is 404.
    for await (const _ of iter) {
      // unreachable in these tests
    }
    return null;
  } catch (e) {
    if (e instanceof FetchError) return e.message;
    throw e;
  }
}

async function runFetchFile(): Promise<string | null> {
  const f = new GitHubFetcher();
  try {
    await f.fetchFile("https://github.com/owner/repo/tree/main/skills/x", "SKILL.md");
    return null;
  } catch (e) {
    if (e instanceof FetchError) return e.message;
    throw e;
  }
}

describe("GitHubFetcher — Authorization header from env var", () => {
  it("attaches Bearer header when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "gho_envvalue123";
    const captured = { headers: new Headers() };
    fetchSpy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.headers) captured.headers = new Headers(init.headers);
      return new Response("nope", { status: 404, statusText: "Not Found" });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await runFetcher();
    expect(captured.headers.get("authorization")).toBe("Bearer gho_envvalue123");
  });

  it("attaches Bearer header when only GH_TOKEN is set (legacy fallback)", async () => {
    process.env.GH_TOKEN = "ghp_legacyenv";
    const captured = { headers: new Headers() };
    fetchSpy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.headers) captured.headers = new Headers(init.headers);
      return new Response("nope", { status: 404, statusText: "Not Found" });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await runFetcher();
    expect(captured.headers.get("authorization")).toBe("Bearer ghp_legacyenv");
  });
});

describe("GitHubFetcher — token never leaks into FetchError", () => {
  it("FetchError.message does NOT contain the token bytes on HTTP error", async () => {
    process.env.GITHUB_TOKEN = "gho_supersecret_DO_NOT_LEAK_424242";
    stubFetchReturning404();

    const msg = await runFetcher();
    expect(msg).not.toBeNull();
    expect(msg!).toMatch(/404/);
    expect(msg!).not.toContain("gho_supersecret_DO_NOT_LEAK_424242");
    expect(msg!).not.toContain("supersecret");
  });

  it("FetchError on network error does NOT contain the token bytes", async () => {
    process.env.GITHUB_TOKEN = "gho_anothersecret_KEEP_HIDDEN_999";
    fetchSpy = vi.fn(async () => {
      throw new Error("ECONNREFUSED to api.github.com");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const msg = await runFetcher();
    expect(msg).not.toBeNull();
    expect(msg!).toMatch(/network error/i);
    expect(msg!).not.toContain("gho_anothersecret_KEEP_HIDDEN_999");
    expect(msg!).not.toContain("anothersecret");
  });
});

describe("GitHubFetcher.fetchFile — Contents API path", () => {
  it("hits the Contents API with subpath + relPath joined and ref query", async () => {
    let capturedUrl = "";
    const captured = { headers: new Headers() };
    fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      if (init?.headers) captured.headers = new Headers(init.headers);
      return new Response("# hello\n", { status: 200, statusText: "OK" });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const f = new GitHubFetcher();
    const buf = await f.fetchFile("https://github.com/owner/repo/tree/main/skills/x", "SKILL.md");
    expect(buf.toString("utf8")).toBe("# hello\n");
    expect(capturedUrl).toBe(
      "https://api.github.com/repos/owner/repo/contents/skills/x/SKILL.md?ref=main",
    );
    expect(captured.headers.get("accept")).toBe("application/vnd.github.raw");
  });

  it("uses the origin's subpath directly when relPath is empty (mcp single-file)", async () => {
    let capturedUrl = "";
    fetchSpy = vi.fn(async (url: string | URL) => {
      capturedUrl = String(url);
      return new Response("{}\n", { status: 200, statusText: "OK" });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const f = new GitHubFetcher();
    const buf = await f.fetchFile("https://github.com/owner/repo/tree/main/mcps/foo.json", "");
    expect(buf.toString("utf8")).toBe("{}\n");
    expect(capturedUrl).toBe(
      "https://api.github.com/repos/owner/repo/contents/mcps/foo.json?ref=main",
    );
  });

  it("rejects empty relPath when the origin has no subpath", async () => {
    fetchSpy = vi.fn(async () => new Response("never", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const f = new GitHubFetcher();
    await expect(f.fetchFile("https://github.com/owner/repo/tree/main", "")).rejects.toThrow(
      FetchError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("URL-encodes path segments containing spaces", async () => {
    let capturedUrl = "";
    fetchSpy = vi.fn(async (url: string | URL) => {
      capturedUrl = String(url);
      return new Response("ok", { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const f = new GitHubFetcher();
    await f.fetchFile(
      "https://github.com/owner/repo/tree/feature%2Fx/skills/my%20skill",
      "SKILL.md",
    );
    expect(capturedUrl).toBe(
      "https://api.github.com/repos/owner/repo/contents/skills/my%2520skill/SKILL.md?ref=feature%252Fx",
    );
  });

  it("FetchError on Contents API 404 does NOT contain the token bytes", async () => {
    process.env.GITHUB_TOKEN = "gho_contents_secret_DO_NOT_LEAK_777";
    fetchSpy = vi.fn(
      async () => new Response("not found", { status: 404, statusText: "Not Found" }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const msg = await runFetchFile();
    expect(msg).not.toBeNull();
    expect(msg!).toMatch(/404/);
    expect(msg!).not.toContain("gho_contents_secret_DO_NOT_LEAK_777");
    expect(msg!).not.toContain("contents_secret");
  });
});

describe("GitHubFetcher.fetchTree — Trees+Blobs subpath transport", () => {
  // Tarball-vs-Trees discrimination is behavioural (we can't observe the
  // private branch directly), so we assert via the request URLs the
  // fetcher hits. The whole `fetchTree` flow is driven through a
  // request-routing fetch stub: each test seeds responses keyed by URL
  // pattern so we can verify exactly which endpoints fired.
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
    const f = new GitHubFetcher();
    const out: { relPath: string; content: string }[] = [];
    for await (const e of f.fetchTree(uri)) {
      out.push({ relPath: e.relPath, content: e.content.toString("utf8") });
    }
    return out;
  }

  it("subpath origin hits Trees API + parallel Blobs API, never the tarball", async () => {
    const { urls } = routeFetch([
      {
        match: /\/git\/trees\/main\?recursive=1$/,
        route: {
          kind: "json",
          body: {
            sha: "abc",
            tree: [
              { path: "skills/x/SKILL.md", type: "blob", sha: "sha-skill-md" },
              { path: "skills/x/lib/util.ts", type: "blob", sha: "sha-util" },
              { path: "skills/y/SKILL.md", type: "blob", sha: "sha-other" },
              { path: "agents/a/AGENTS.md", type: "blob", sha: "sha-noise" },
            ],
            truncated: false,
          },
        },
      },
      { match: /\/git\/blobs\/sha-skill-md$/, route: { kind: "raw", body: "# skill x\n" } },
      { match: /\/git\/blobs\/sha-util$/, route: { kind: "raw", body: "export const x = 1;\n" } },
    ]);

    const out = await collect("https://github.com/owner/repo/tree/main/skills/x");

    expect(out.map((e) => e.relPath).sort()).toEqual(["SKILL.md", "lib/util.ts"]);
    expect(out.find((e) => e.relPath === "SKILL.md")?.content).toBe("# skill x\n");
    expect(out.find((e) => e.relPath === "lib/util.ts")?.content).toBe("export const x = 1;\n");
    // Trees + only the two matching blobs were requested. No tarball,
    // no extra blob (skills/y, agents/a were filtered before fetch).
    expect(urls).toHaveLength(3);
    expect(urls.some((u) => u.includes("/tarball/"))).toBe(false);
    expect(urls.some((u) => u.includes("/git/blobs/sha-other"))).toBe(false);
    expect(urls.some((u) => u.includes("/git/blobs/sha-noise"))).toBe(false);
  });

  it("Blobs API request carries Accept: application/vnd.github.raw (raw bytes, not base64)", async () => {
    let blobAccept: string | null = null;
    const spy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("?recursive=1")) {
        return new Response(
          JSON.stringify({
            tree: [{ path: "skills/x/SKILL.md", type: "blob", sha: "s1" }],
            truncated: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("/git/blobs/")) {
        blobAccept = new Headers(init?.headers).get("accept");
        return new Response("# hi\n", { status: 200 });
      }
      return new Response("nope", { status: 599 });
    });
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;

    await collect("https://github.com/owner/repo/tree/main/skills/x");
    expect(blobAccept).toBe("application/vnd.github.raw");
  });

  it("single-file subpath yields the matched blob under its basename", async () => {
    routeFetch([
      {
        match: /\/git\/trees\/main\?recursive=1$/,
        route: {
          kind: "json",
          body: {
            tree: [
              { path: "mcps/foo.json", type: "blob", sha: "sha-foo" },
              { path: "mcps/bar.json", type: "blob", sha: "sha-bar" },
            ],
            truncated: false,
          },
        },
      },
      { match: /\/git\/blobs\/sha-foo$/, route: { kind: "raw", body: '{"name":"foo"}' } },
    ]);

    const out = await collect("https://github.com/owner/repo/tree/main/mcps/foo.json");
    expect(out).toHaveLength(1);
    expect(out[0]?.relPath).toBe("foo.json");
    expect(out[0]?.content).toBe('{"name":"foo"}');
  });

  it("falls back to tarball when the Trees API marks the response truncated", async () => {
    const tarUrls: string[] = [];
    const spy = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("?recursive=1")) {
        return new Response(JSON.stringify({ tree: [], truncated: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/tarball/")) {
        tarUrls.push(u);
        // Return a 502 so the fallback fails fast — we only want to
        // observe that the fallback URL was hit, not parse a real tarball.
        return new Response("upstream error", { status: 502, statusText: "Bad Gateway" });
      }
      return new Response("unmatched", { status: 599 });
    });
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;

    const f = new GitHubFetcher();
    await expect(async () => {
      for await (const _ of f.fetchTree("https://github.com/owner/repo/tree/main/skills/x")) {
        // unreachable — we expect the tarball fallback's 502 to throw
      }
    }).rejects.toThrow(FetchError);
    expect(tarUrls).toHaveLength(1);
    expect(tarUrls[0]).toContain("/tarball/main");
  });

  it("whole-repo origin (no subpath) skips Trees+Blobs and goes straight to tarball", async () => {
    const urls: string[] = [];
    const spy = vi.fn(async (url: string | URL) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/tarball/")) {
        return new Response("tar", { status: 502, statusText: "Bad Gateway" });
      }
      return new Response("unmatched", { status: 599 });
    });
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;

    const f = new GitHubFetcher();
    await expect(async () => {
      for await (const _ of f.fetchTree("https://github.com/owner/repo/tree/main")) {
        // unreachable
      }
    }).rejects.toThrow(FetchError);
    // No Trees API call: the whole-repo branch never tries blob fan-out.
    expect(urls.some((u) => u.includes("/git/trees/"))).toBe(false);
    expect(urls.some((u) => u.includes("/tarball/"))).toBe(true);
  });

  it("throws FetchError when subpath matches no blobs in the tree", async () => {
    routeFetch([
      {
        match: /\/git\/trees\/main\?recursive=1$/,
        route: {
          kind: "json",
          body: {
            tree: [{ path: "skills/y/SKILL.md", type: "blob", sha: "sha-y" }],
            truncated: false,
          },
        },
      },
    ]);

    const f = new GitHubFetcher();
    await expect(async () => {
      for await (const _ of f.fetchTree("https://github.com/owner/repo/tree/main/skills/x")) {
        // unreachable
      }
    }).rejects.toThrow(/matched no blobs/);
  });

  it("FetchError on Blobs API 404 does NOT contain the token bytes", async () => {
    process.env.GITHUB_TOKEN = "gho_blobs_secret_KEEP_HIDDEN_555";
    routeFetch([
      {
        match: /\/git\/trees\/main\?recursive=1$/,
        route: {
          kind: "json",
          body: {
            tree: [{ path: "skills/x/SKILL.md", type: "blob", sha: "sha-missing" }],
            truncated: false,
          },
        },
      },
      {
        match: /\/git\/blobs\/sha-missing$/,
        route: { kind: "status", status: 404, statusText: "Not Found" },
      },
    ]);

    const f = new GitHubFetcher();
    let msg: string | null = null;
    try {
      for await (const _ of f.fetchTree("https://github.com/owner/repo/tree/main/skills/x")) {
        // unreachable
      }
    } catch (e) {
      if (e instanceof FetchError) msg = e.message;
      else throw e;
    }
    expect(msg).not.toBeNull();
    expect(msg!).toMatch(/404/);
    expect(msg!).not.toContain("gho_blobs_secret_KEEP_HIDDEN_555");
    expect(msg!).not.toContain("blobs_secret");
  });
});
