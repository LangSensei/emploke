/**
 * API-contract tests for the `emploke` CLI.
 *
 * These cases exercise the full commander → action → `makeClient` →
 * `ApiClient.call` → fetch pipeline, but the fetch implementation is
 * a `vi.spyOn(globalThis, "fetch")` stub — no server is booted. The
 * goal is to pin:
 *
 *   - URL + method shape (route key resolves to the right path)
 *   - response unwrap + rendering (`--json` vs default table)
 *   - error mapping (5xx → exit code + clear stderr)
 *
 * Why not msw / nock: keeps the test deps surface small (per
 * issue #163's "no new test dependencies" constraint). The repo's
 * existing fetch-mock primitive is the same `typeof fetch` swap
 * already used by `api-client.test.ts` and `task-activity.test.ts`.
 *
 * Pairs with:
 *   - `argv-validation.test.ts` for cases that don't touch fetch
 *   - `integration-smoke.test.ts` for cases that need a real server
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runCli } from "./_helpers/run-cli.js";

let home: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "emploke-cli-api-contract-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Capture {
  url: string;
  method: string;
}

/**
 * Install a fetch stub that returns the given response on the first
 * call (and records the URL + method). Subsequent calls (none expected
 * in these tests) return a 500 so any accidental extra request fails
 * loudly instead of silently 200-ing.
 *
 * The stub points the CLI at a non-resolvable `EMPLOKE_SERVER` so even
 * if a regression bypassed it, the resulting connection-refused error
 * would surface in the assertion rather than silently passing.
 */
function stubFetch(response: { status: number; body: string; contentType?: string }): Capture {
  const cap: Capture = { url: "", method: "" };
  let called = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (called) {
      return new Response("unexpected second fetch call", { status: 500 });
    }
    called = true;
    cap.url = String(input);
    cap.method = String(init?.method ?? "GET");
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": response.contentType ?? "application/json" },
    });
  });
  return cap;
}

// Force every CLI invocation here through a known base URL so the
// captured request URL is deterministic — we don't want the assertion
// to depend on whether some other test left a runtime.json behind.
const SERVER_URL = "http://stub.local";

function env(): Record<string, string | undefined> {
  return {
    EMPLOKE_HOME: home,
    EMPLOKE_SERVER: SERVER_URL,
    EMPLOKE_WORKSPACE: undefined,
  };
}

describe("API contract — `emploke runtime list`", () => {
  it("GETs /api/runtimes and renders the table containing `copilot`", async () => {
    const cap = stubFetch({
      status: 200,
      body: JSON.stringify([
        { kind: "copilot", capabilities: { streaming: true } },
        { kind: "echo", capabilities: {} },
      ]),
    });
    const r = await runCli(["runtime", "list"], env());
    expect(r.exitCode, r.stderr).toBe(0);
    expect(cap.method).toBe("GET");
    expect(cap.url).toBe(`${SERVER_URL}/api/runtimes`);
    expect(r.stdout).toContain("copilot");
  });

  it("`--json` returns the raw array (response unwrap pin)", async () => {
    stubFetch({
      status: 200,
      body: JSON.stringify([{ kind: "copilot", capabilities: { streaming: true } }]),
    });
    const r = await runCli(["runtime", "list", "--json"], env());
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as Array<{ kind: string }>;
    expect(parsed.map((x) => x.kind)).toContain("copilot");
  });
});

describe("API contract — `emploke config`", () => {
  it("GETs /api/config and surfaces emplokeHome / host / port from the wire payload", async () => {
    // The CLI doesn't read EMPLOKE_HOME for `config` — it asks the
    // server. Pin that wiring by returning a payload whose
    // `emplokeHome` is unrelated to the env var; the CLI must echo
    // the server's value verbatim, not the env.
    const cap = stubFetch({
      status: 200,
      body: JSON.stringify({
        emplokeHome: "/srv/emploke-home",
        currentWorkspace: null,
        host: "127.0.0.1",
        port: 8787,
        pathSeparator: path.sep,
        tasks: { pollIntervalMs: 500 },
      }),
    });
    const r = await runCli(["config", "--json"], env());
    expect(r.exitCode, r.stderr).toBe(0);
    expect(cap.method).toBe("GET");
    expect(cap.url).toBe(`${SERVER_URL}/api/config`);
    const body = JSON.parse(r.stdout) as { emplokeHome: string; host: string; port: number };
    expect(body.emplokeHome).toBe("/srv/emploke-home");
    expect(body.host).toBe("127.0.0.1");
    expect(body.port).toBe(8787);
  });
});

describe("API contract — `emploke task dispatch` server-side error mapping", () => {
  it("surfaces a clean message when the server rejects an unknown agent (404)", async () => {
    // The argv layer rejects missing `--agent` / `--brief` / newline
    // briefs (see argv-validation.test.ts); the case here is a
    // well-formed request that the server refuses. We pin that the
    // error envelope ({error, code}) round-trips through
    // formatError into a non-zero exit + a stderr line naming both
    // the server's message and the typed code.
    const cap = stubFetch({
      status: 404,
      body: JSON.stringify({
        error: 'agent "ghost" not installed',
        code: "EntryNotFoundError",
      }),
    });
    const r = await runCli(
      ["task", "dispatch", "--workspace", "ws-1", "--agent", "ghost", "--brief", "noop"],
      env(),
    );
    expect(r.exitCode).not.toBe(0);
    expect(cap.method).toBe("POST");
    expect(cap.url).toBe(`${SERVER_URL}/api/workspaces/ws-1/tasks`);
    expect(r.stderr).toContain('agent "ghost" not installed');
    expect(r.stderr).toContain("HTTP 404");
    expect(r.stderr).toContain("EntryNotFoundError");
  });
});
