/**
 * Argv + wire tests for the `--url` / `--file` install-source flags on
 * every catalog install + resolve command.
 *
 * Five commands, six invariants each (= 30 assertions per command set):
 *  1. Neither flag → exit 2 with both `--url` and `--file` named.
 *  2. Both flags → exit 2 with "cannot provide both".
 *  3. Legacy positional `<origin>` form is rejected (commander emits an
 *     "unknown" / "too many" usage error; exit non-zero).
 *  4. `--url <url>` passes through verbatim to the wire `{ origin }`.
 *  5. `--file <abs>` prepends `file:` on the wire.
 *  6. `--file file:<abs>` is tolerated unchanged.
 *  7. `--url file:<abs>` smuggling guard → exit 2; stderr names both
 *     `file:` and `--file`.
 *
 * The wire-shape assertions reuse the same `vi.spyOn(globalThis, "fetch")`
 * stub pattern as `api-contract.test.ts` so the test stays in-process
 * (no server bootup, no msw dependency).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runCli } from "./_helpers/run-cli.js";

let home: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "emploke-cli-install-source-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const SERVER_URL = "http://stub.local";

function env(): Record<string, string | undefined> {
  return {
    EMPLOKE_HOME: home,
    EMPLOKE_SERVER: SERVER_URL,
    EMPLOKE_WORKSPACE: "ws-1",
  };
}

interface Capture {
  url: string;
  method: string;
  body: { origin?: string } | null;
}

/**
 * Stub a single 200 response and capture the request URL, method, and
 * parsed JSON body. A second call returns 500 so any accidental extra
 * fetch fails loudly.
 */
function stubFetchCapture(responseBody: string): Capture {
  const cap: Capture = { url: "", method: "", body: null };
  let called = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (called) return new Response("unexpected second fetch", { status: 500 });
    called = true;
    cap.url = String(input);
    cap.method = String(init?.method ?? "GET");
    const raw = init?.body;
    if (typeof raw === "string") {
      try {
        cap.body = JSON.parse(raw) as { origin?: string };
      } catch {
        cap.body = null;
      }
    }
    return new Response(responseBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return cap;
}

/** Wire-response bodies for each command's happy path. */
const INSTALL_BODY = JSON.stringify({ installed: [], skipped: [], failed: [] });
const RESOLVE_BODY = JSON.stringify({
  rootOrigin: "x",
  rootFqn: "f",
  isSync: false,
  upToDate: false,
  orphans: [],
  nodes: [],
});

/**
 * Per-command spec. The expected route path is derived from
 * `apiSegment`; the absolute URL is `${SERVER_URL}/api/workspaces/ws-1/catalog/${apiSegment}`.
 */
interface Command {
  /** Argv prefix, e.g. ["catalog", "skill", "install"]. */
  readonly argv: readonly string[];
  /** Catalog kind segment used in the route (`skills` | `agents` | `mcps`). */
  readonly apiSegment: "skills" | "agents" | "mcps";
  /** Response body shape (install responses differ from resolve). */
  readonly responseBody: string;
  /** True if the route is `/resolve` (suffix on the URL). */
  readonly isResolve: boolean;
}

const COMMANDS: readonly Command[] = [
  {
    argv: ["catalog", "skill", "install"],
    apiSegment: "skills",
    responseBody: INSTALL_BODY,
    isResolve: false,
  },
  {
    argv: ["catalog", "skill", "resolve"],
    apiSegment: "skills",
    responseBody: RESOLVE_BODY,
    isResolve: true,
  },
  {
    argv: ["catalog", "agent", "install"],
    apiSegment: "agents",
    responseBody: INSTALL_BODY,
    isResolve: false,
  },
  {
    argv: ["catalog", "agent", "resolve"],
    apiSegment: "agents",
    responseBody: RESOLVE_BODY,
    isResolve: true,
  },
  {
    argv: ["catalog", "mcp", "install"],
    apiSegment: "mcps",
    responseBody: INSTALL_BODY,
    isResolve: false,
  },
];

function expectedUrl(cmd: Command): string {
  const path = cmd.isResolve ? `${cmd.apiSegment}/resolve` : cmd.apiSegment;
  return `${SERVER_URL}/api/workspaces/ws-1/catalog/${path}`;
}

for (const cmd of COMMANDS) {
  const label = cmd.argv.join(" ");

  describe(`${label} --url / --file flag validation`, () => {
    it("rejects when neither --url nor --file is provided", async () => {
      // No fetch stub — the argv prelude must reject before any
      // network call is attempted.
      const r = await runCli([...cmd.argv], env());
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/--url/);
      expect(r.stderr).toMatch(/--file/);
    });

    it("rejects when both --url and --file are provided", async () => {
      const r = await runCli(
        [...cmd.argv, "--url", "https://github.com/o/r/tree/main/x", "--file", "/abs/x"],
        env(),
      );
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/cannot provide both/);
    });

    it("rejects the old positional <origin> form with a non-zero exit", async () => {
      // commander.js emits "too many arguments" or "unknown argument";
      // the test just pins that the old form is no longer silently
      // accepted as the install source.
      const r = await runCli([...cmd.argv, "https://github.com/o/r/tree/main/x"], env());
      expect(r.exitCode).not.toBe(0);
    });

    it("--url passes through to wire { origin: <url> }", async () => {
      const cap = stubFetchCapture(cmd.responseBody);
      const r = await runCli([...cmd.argv, "--url", "https://github.com/o/r/tree/main/x"], env());
      expect(r.exitCode, r.stderr).toBe(0);
      expect(cap.method).toBe("POST");
      expect(cap.url).toBe(expectedUrl(cmd));
      expect(cap.body?.origin).toBe("https://github.com/o/r/tree/main/x");
    });

    it("--file prepends file: prefix to absolute path", async () => {
      const cap = stubFetchCapture(cmd.responseBody);
      const r = await runCli([...cmd.argv, "--file", "/abs/x"], env());
      expect(r.exitCode, r.stderr).toBe(0);
      expect(cap.body?.origin).toBe("file:/abs/x");
    });

    it("--file tolerates an already-prefixed file: input", async () => {
      const cap = stubFetchCapture(cmd.responseBody);
      const r = await runCli([...cmd.argv, "--file", "file:/abs/x"], env());
      expect(r.exitCode, r.stderr).toBe(0);
      expect(cap.body?.origin).toBe("file:/abs/x");
    });

    it("rejects --url with a file: URI (smuggling guard)", async () => {
      const r = await runCli([...cmd.argv, "--url", "file:/abs/x"], env());
      expect(r.exitCode).toBe(2);
      // Message must name both `file:` and `--file` so the user can
      // self-correct.
      expect(r.stderr).toMatch(/file:/);
      expect(r.stderr).toMatch(/--file/);
    });
  });
}

describe("catalog skill install --file with Windows paths", () => {
  // Spot-check: the helper just prepends `file:` if missing; Windows
  // paths like `C:\foo\bar` start with a drive letter, not `file:`,
  // so they get the prefix added. The server-side `parseOrigin`
  // already accepts these; the CLI layer does no Windows-specific
  // handling.
  it("--file C:\\\\foo\\\\bar prepends file: prefix unchanged", async () => {
    const cap = stubFetchCapture(INSTALL_BODY);
    const r = await runCli(["catalog", "skill", "install", "--file", "C:\\foo\\bar"], env());
    expect(r.exitCode, r.stderr).toBe(0);
    expect(cap.body?.origin).toBe("file:C:\\foo\\bar");
  });
});
