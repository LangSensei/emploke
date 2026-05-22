/**
 * Argv-layer validation tests for the `emploke` CLI.
 *
 * Pure in-process: every case calls `run(...)` (via the `runCli`
 * helper) without spawning a subprocess and without starting an HTTP
 * server. The behaviours under test all reject inputs at the argv /
 * action-prelude layer, BEFORE any `fetch(...)` call is reached:
 *
 *   - commander rejections (`requiredOption`, missing arg) — exit 2
 *     via the `EX_USAGE` mapping in `index.ts:run`.
 *   - per-action prelude checks (mutex combos, numeric validation,
 *     newline-in-brief) — return `{ exitCode: 2, stderr }` before
 *     `makeClient` issues any request.
 *   - `workspace use` stub — returns exit 2 with a redirect message;
 *     also covers the "no id" path enabled by the optional `[id]`
 *     argument shape (see `index.ts` near the registration site).
 *
 * Replaces the spawn-per-case rejection coverage that used to live in
 * `commands.test.ts`. See issue #163 for the root-cause analysis
 * (Windows CI flake from 18× cold boots).
 *
 * Pairs with:
 *   - `api-contract.test.ts` for cases that need a mock fetch
 *   - `integration-smoke.test.ts` for cases that need a real server
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./_helpers/run-cli.js";

// One shared tmpdir for every case — none of these tests need an
// isolated home (they all reject before reading any state from it).
// EMPLOKE_HOME just has to point somewhere with no `runtime.json` so
// `makeClient` falls through to the DEFAULT_BASE_URL without surprises.
let home: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "emploke-cli-argv-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Per-case env: empty EMPLOKE_WORKSPACE so the "no workspace selected"
// path is exercised even if the dev shell exports one, plus a unique
// EMPLOKE_SERVER pointing nowhere so any accidental network attempt
// would fail loudly (none should). `EMPLOKE_HOME` is set per-test from
// `home` above.
function env(): Record<string, string | undefined> {
  return {
    EMPLOKE_HOME: home,
    EMPLOKE_WORKSPACE: undefined,
    EMPLOKE_SERVER: undefined,
  };
}

describe("argv validation (commander missing-required)", () => {
  it("`workspace add` without --name → exit 2 with `required` in stderr", async () => {
    const r = await runCli(["workspace", "add", "--workspace-dir", "/tmp/x"], env());
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toLowerCase()).toContain("required");
  });

  it("`task dispatch` without --agent → exit 2 mentioning the missing option", async () => {
    const r = await runCli(["task", "dispatch", "--brief", "noop"], env());
    expect(r.exitCode).toBe(2);
    // Commander's wording is `error: required option '--agent <name>' not specified`.
    // Pin only the option name + the "required" token so a future commander
    // upgrade that tweaks the surrounding prose doesn't churn this test.
    expect(r.stderr.toLowerCase()).toContain("agent");
    expect(r.stderr.toLowerCase()).toContain("required");
  });

  it("`task dispatch` without --brief → exit 2 mentioning the missing option", async () => {
    const r = await runCli(["task", "dispatch", "--agent", "writer"], env());
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toLowerCase()).toContain("brief");
    expect(r.stderr.toLowerCase()).toContain("required");
  });
});

describe("argv validation (per-action prelude checks)", () => {
  it("`task dispatch --brief 'first\\nsecond'` rejects newline-containing brief", async () => {
    const r = await runCli(
      ["task", "dispatch", "--agent", "writer", "--brief", "first\nsecond"],
      env(),
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toLowerCase()).toContain("brief");
    expect(r.stderr.toLowerCase()).toContain("single line");
  });

  it("`task dispatch --details + --details-file` rejects mutually-exclusive combo", async () => {
    const r = await runCli(
      [
        "task",
        "dispatch",
        "--agent",
        "writer",
        "--brief",
        "ok",
        "--details",
        "inline",
        "--details-file",
        "some-file.md",
      ],
      env(),
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toLowerCase()).toContain("mutually exclusive");
  });

  it("`task activity --after abc` rejects non-numeric value", async () => {
    const r = await runCli(["task", "activity", "tid-x", "--after", "abc"], env());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--after");
    expect(r.stderr.toLowerCase()).toContain("non-negative integer");
  });

  it("`task activity --after -1` rejects negative value", async () => {
    const r = await runCli(["task", "activity", "tid-x", "--after", "-1"], env());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--after");
  });

  it("`task activity --before abc` rejects non-numeric value", async () => {
    const r = await runCli(["task", "activity", "tid-x", "--before", "abc"], env());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--before");
    expect(r.stderr.toLowerCase()).toContain("non-negative integer");
  });

  it("`task activity --before 5 --after 3` rejects mutually-exclusive combo", async () => {
    const r = await runCli(["task", "activity", "tid-x", "--before", "5", "--after", "3"], env());
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toLowerCase()).toContain("mutually exclusive");
  });

  it("`task activity --before 5 --follow` rejects (--before is one-shot only)", async () => {
    const r = await runCli(["task", "activity", "tid-x", "--before", "5", "--follow"], env());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--before");
    expect(r.stderr).toContain("--follow");
  });

  it("`task activity --follow --limit 10` rejects the conflicting combo", async () => {
    const r = await runCli(["task", "activity", "tid-x", "--follow", "--limit", "10"], env());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--limit");
    expect(r.stderr).toContain("--follow");
  });
});

describe("argv validation (workspace selection + `use` stub)", () => {
  it("workspace-scoped command fails clearly when no workspace is set", async () => {
    // `resolveWorkspace` throws before any HTTP call — see
    // `connect.ts`. The error surfaces through `formatError` as exit
    // 1 with a message that names both `--workspace` and
    // `EMPLOKE_WORKSPACE` so users can pick a fix.
    const r = await runCli(["session", "list"], env());
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("workspace");
    expect(r.stderr).toContain("--workspace");
    expect(r.stderr).toContain("EMPLOKE_WORKSPACE");
  });

  it("`workspace use <id>` is a removed-stub: exit 2 and points at the new flow", async () => {
    const r = await runCli(["workspace", "use", "ws-anything"], env());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("was removed");
    expect(r.stderr).toContain("--workspace");
    expect(r.stderr).toContain("EMPLOKE_WORKSPACE");
    // The provided id is echoed back so users can copy-paste it into
    // the new flow without re-typing.
    expect(r.stderr).toContain("ws-anything");
  });

  it("`workspace use` (no id) still hits the stub, not commander's missing-arg error", async () => {
    // The argument was made optional `[id]` (not `<id>`) specifically
    // so this case lands on our redirection message rather than
    // commander's generic `error: missing required argument 'id'`.
    const r = await runCli(["workspace", "use"], env());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("was removed");
    expect(r.stderr).toContain("EMPLOKE_WORKSPACE");
  });
});

// ─── lifecycle-adjacent argv / file-read cases (no subprocess needed) ─
//
// The seven cases below moved out of `lifecycle.test.ts` per issue #130
// Tier 2: they only inspect argv parsing or read the absence of
// `runtime.json` — no `spawn`, no signals, no live server. Going
// in-process drops each from ~2.5 s (cold `node bin.js`) to a handful
// of milliseconds. The genuinely-subprocess-bound lifecycle cases
// (start/restart/stop happy paths, idempotency, stale-pid cleanup)
// live in `spawn-smoke.test.ts`.

describe("argv validation (status / stop without a server)", () => {
  // Each case needs its own EMPLOKE_HOME so an absent `runtime.json` is
  // a hard guarantee and not a leak from a prior case.
  let lcHome: string;

  beforeEach(async () => {
    lcHome = await mkdtemp(path.join(tmpdir(), "emploke-cli-lc-argv-"));
  });
  afterEach(async () => {
    await rm(lcHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function lcEnv(): Record<string, string | undefined> {
    return {
      EMPLOKE_HOME: lcHome,
      EMPLOKE_WORKSPACE: undefined,
      EMPLOKE_SERVER: undefined,
    };
  }

  it("status reports not_running when there is no runtime.json (exit 3)", async () => {
    const r = await runCli(["status"], lcEnv());
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toMatch(/not running/);
  });

  it("status --json emits machine-readable payload", async () => {
    const r = await runCli(["status", "--json"], lcEnv());
    expect(r.exitCode).toBe(3);
    const body = JSON.parse(r.stdout);
    expect(body.state).toBe("not_running");
  });

  it("stop is idempotent when nothing is running", async () => {
    const r = await runCli(["stop"], lcEnv());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/not running/);
  });
});

describe("argv validation (help / no-args / unknown subcommand)", () => {
  // These cases never read state from EMPLOKE_HOME, but commander still
  // resolves the env chain during help formatting — point it at a real
  // tmpdir so we don't trip on a missing path on stricter filesystems.
  let helpHome: string;

  beforeAll(async () => {
    helpHome = await mkdtemp(path.join(tmpdir(), "emploke-cli-help-"));
  });
  afterAll(async () => {
    await rm(helpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function helpEnv(): Record<string, string | undefined> {
    return {
      EMPLOKE_HOME: helpHome,
      EMPLOKE_WORKSPACE: undefined,
      EMPLOKE_SERVER: undefined,
    };
  }

  it("no-args prints help on exit 0", async () => {
    const r = await runCli([], helpEnv());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Usage:/);
    expect(r.stdout).toContain("emploke");
  });

  it("`emploke help` prints top-level help on exit 0", async () => {
    const r = await runCli(["help"], helpEnv());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Commands:/);
    expect(r.stdout).toContain("start");
    expect(r.stdout).toContain("stop");
  });

  it("`emploke help <subcommand>` prints the subcommand help", async () => {
    const r = await runCli(["help", "start"], helpEnv());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Usage:[\s\S]*emploke start/);
    expect(r.stdout).toContain("--port");
  });

  it("unknown subcommand exits 2", async () => {
    const r = await runCli(["zzznotacommand"], helpEnv());
    expect(r.exitCode).toBe(2);
    // commander phrases this as `error: unknown command '<name>'`. Don't
    // pin the exact wording — just assert we got a usage-style stderr
    // that mentions the offending token.
    expect(r.stderr.toLowerCase()).toContain("unknown command");
  });
});
