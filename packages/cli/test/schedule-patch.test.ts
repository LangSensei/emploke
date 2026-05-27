/**
 * `emploke schedule patch` — general partial-update CLI surface
 * (issue #210; complements the thin `enable` / `disable` wrappers).
 *
 * Calls `schedulePatch(...)` directly with a `vi.spyOn(globalThis,
 * "fetch")` stub so the full action body — including the
 * fetch-merge-send round-trip for sparse trigger / target updates —
 * exercises real production code rather than an inline re-implementation.
 * `workspace` + `server` flags are passed explicitly so
 * `resolveWorkspace` / `resolveConnection` return deterministic values
 * without touching any test-env globals.
 *
 * Why this exists at all: the server-side PATCH replaces `trigger` /
 * `target` wholesale (see `schedule-entity.ts:withPatched` and
 * `schedule-service.ts:114-135`), so when the user supplies only a
 * subset of fields the CLI must GET the current schedule, merge in the
 * unspecified leaves, and PATCH the full object. The single-field
 * fast path (--name / --enabled / --no-enabled) skips the GET because
 * those fields don't require any merging.
 *
 * Pairs with: `task-cancel.test.ts` (mock-fetch verb pattern),
 * `api-contract.test.ts` (full-pipeline pattern via `runCli`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { schedulePatch } from "../src/commands/schedule.js";
import { runCli } from "./_helpers/run-cli.js";

const SERVER_URL = "http://stub.local";
const WSID = "ws-abc";
const SID = "20260601-aaaaaaaa";

let home: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "emploke-cli-schedule-patch-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

interface MockResponse {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * Install a fetch stub that returns the i-th response on the i-th call
 * (and records the URL + method + parsed JSON body). Any call beyond
 * the configured array returns a 500 so an unexpected extra request
 * surfaces loudly in assertions instead of silently 200-ing.
 */
function stubFetchMulti(responses: readonly MockResponse[]): { calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const r = responses[i];
    i += 1;
    const rawBody = init?.body;
    let parsed: unknown;
    if (typeof rawBody === "string" && rawBody.length > 0) {
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = rawBody;
      }
    }
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: parsed,
    });
    if (r === undefined) {
      return new Response(`unexpected request #${i}: ${String(input)}`, { status: 500 });
    }
    return new Response(r.body, {
      status: r.status,
      headers: { "content-type": r.contentType ?? "application/json" },
    });
  });
  return { calls };
}

const sampleSchedule = {
  id: SID,
  name: "Daily Brief",
  trigger: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
  target: {
    kind: "task",
    agent: "emploke/dev",
    instructions: "do the thing",
    runtime: "copilot",
  },
  enabled: true,
  createdAt: "2026-05-27T00:00:00.000Z",
  updatedAt: "2026-05-27T00:00:00.000Z",
};

// `schedules.get` returns the wire Schedule plus a derived `describe`
// (zh_CN cron text). The patch path should NOT echo `describe` back
// into the PATCH body — the assertions on `body` below enforce that.
const sampleScheduleGet = { ...sampleSchedule, describe: "every day at 9" };

function commonOpts() {
  return { workspace: WSID, server: SERVER_URL, home };
}

const PATCH_URL = `${SERVER_URL}/api/workspaces/${WSID}/schedules/${SID}`;
const GET_URL = PATCH_URL;

describe("schedulePatch — single-field fast path (no preceding GET)", () => {
  it("--name issues exactly 1 PATCH with body={name}", async () => {
    const { calls } = stubFetchMulti([
      { status: 200, body: JSON.stringify({ ...sampleSchedule, name: "Renamed" }) },
    ]);
    const r = await schedulePatch({ ...commonOpts(), sid: SID, name: "Renamed" });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe(`schedule ${SID} patched\n`);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe(PATCH_URL);
    expect(calls[0]?.body).toEqual({ name: "Renamed" });
  });

  it("--enabled (true) issues exactly 1 PATCH with body={enabled:true}", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleSchedule) }]);
    const r = await schedulePatch({ ...commonOpts(), sid: SID, enabled: true });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ enabled: true });
  });

  it("--no-enabled (enabled=false) issues exactly 1 PATCH with body={enabled:false}", async () => {
    const { calls } = stubFetchMulti([
      { status: 200, body: JSON.stringify({ ...sampleSchedule, enabled: false }) },
    ]);
    const r = await schedulePatch({ ...commonOpts(), sid: SID, enabled: false });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ enabled: false });
  });
});

describe("schedulePatch — sparse trigger updates (GET + merge + PATCH)", () => {
  it("--cron alone fetches GET and preserves existing tz", async () => {
    const { calls } = stubFetchMulti([
      { status: 200, body: JSON.stringify(sampleScheduleGet) },
      { status: 200, body: JSON.stringify(sampleSchedule) },
    ]);
    const r = await schedulePatch({ ...commonOpts(), sid: SID, cron: "0 10 * * *" });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(GET_URL);
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.body).toEqual({
      trigger: { kind: "cron", expr: "0 10 * * *", tz: "Asia/Shanghai" },
    });
  });

  it("--tz alone fetches GET and preserves existing cron expr", async () => {
    const { calls } = stubFetchMulti([
      { status: 200, body: JSON.stringify(sampleScheduleGet) },
      { status: 200, body: JSON.stringify(sampleSchedule) },
    ]);
    const r = await schedulePatch({ ...commonOpts(), sid: SID, tz: "UTC" });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.body).toEqual({
      trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    });
  });

  it("--cron + --tz skip the GET (full trigger present)", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleSchedule) }]);
    const r = await schedulePatch({
      ...commonOpts(),
      sid: SID,
      cron: "*/5 * * * *",
      tz: "UTC",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({
      trigger: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
    });
  });
});

describe("schedulePatch — sparse target updates (GET + merge + PATCH)", () => {
  it("--agent alone preserves existing instructions/runtime", async () => {
    const { calls } = stubFetchMulti([
      { status: 200, body: JSON.stringify(sampleScheduleGet) },
      { status: 200, body: JSON.stringify(sampleSchedule) },
    ]);
    const r = await schedulePatch({ ...commonOpts(), sid: SID, agent: "emploke/qa" });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.body).toEqual({
      target: {
        kind: "task",
        agent: "emploke/qa",
        instructions: "do the thing",
        runtime: "copilot",
      },
    });
  });

  it("--instructions alone preserves existing agent/runtime", async () => {
    const { calls } = stubFetchMulti([
      { status: 200, body: JSON.stringify(sampleScheduleGet) },
      { status: 200, body: JSON.stringify(sampleSchedule) },
    ]);
    const r = await schedulePatch({
      ...commonOpts(),
      sid: SID,
      instructions: "new instructions",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.body).toEqual({
      target: {
        kind: "task",
        agent: "emploke/dev",
        instructions: "new instructions",
        runtime: "copilot",
      },
    });
  });

  it("--runtime alone preserves existing agent/instructions", async () => {
    const { calls } = stubFetchMulti([
      { status: 200, body: JSON.stringify(sampleScheduleGet) },
      { status: 200, body: JSON.stringify(sampleSchedule) },
    ]);
    const r = await schedulePatch({ ...commonOpts(), sid: SID, runtime: "echo" });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.body).toEqual({
      target: {
        kind: "task",
        agent: "emploke/dev",
        instructions: "do the thing",
        runtime: "echo",
      },
    });
  });

  it("--agent + --instructions still GETs the current schedule and preserves runtime", async () => {
    const { calls } = stubFetchMulti([
      { status: 200, body: JSON.stringify(sampleScheduleGet) },
      { status: 200, body: JSON.stringify(sampleSchedule) },
    ]);
    const r = await schedulePatch({
      ...commonOpts(),
      sid: SID,
      agent: "emploke/qa",
      instructions: "go",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(GET_URL);
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.body).toEqual({
      target: {
        kind: "task",
        agent: "emploke/qa",
        instructions: "go",
        runtime: "copilot",
      },
    });
  });

  it("preserves existing target.runtime when --runtime is omitted (regression — was silently dropped pre-iter3)", async () => {
    const { calls } = stubFetchMulti([
      { status: 200, body: JSON.stringify(sampleScheduleGet) },
      { status: 200, body: JSON.stringify(sampleSchedule) },
    ]);
    const r = await schedulePatch({
      ...commonOpts(),
      sid: SID,
      agent: "new-agent",
      instructions: "new",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.body).toEqual({
      target: {
        kind: "task",
        agent: "new-agent",
        instructions: "new",
        runtime: "copilot",
      },
    });
  });
});

describe("schedulePatch — combined fields", () => {
  it("name + full trigger + full target → GET (for target merge) + PATCH preserves runtime", async () => {
    const { calls } = stubFetchMulti([
      { status: 200, body: JSON.stringify(sampleScheduleGet) },
      { status: 200, body: JSON.stringify(sampleSchedule) },
    ]);
    const r = await schedulePatch({
      ...commonOpts(),
      sid: SID,
      name: "All-At-Once",
      cron: "0 12 * * *",
      tz: "UTC",
      agent: "emploke/qa",
      instructions: "go",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.body).toEqual({
      name: "All-At-Once",
      trigger: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
      target: {
        kind: "task",
        agent: "emploke/qa",
        instructions: "go",
        runtime: "copilot",
      },
    });
  });

  it("--json emits the updated schedule as formatted JSON", async () => {
    const updated = { ...sampleSchedule, name: "Renamed" };
    stubFetchMulti([{ status: 200, body: JSON.stringify(updated) }]);
    const r = await schedulePatch({
      ...commonOpts(),
      sid: SID,
      name: "Renamed",
      json: true,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout ?? "") as { name: string };
    expect(parsed.name).toBe("Renamed");
  });
});

describe("schedulePatch — input validation (no fetch)", () => {
  it("empty sid → exit 2, no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await schedulePatch({ ...commonOpts(), sid: "", name: "x" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toBe("schedule id is required\n");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("whitespace-only sid → exit 2, no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await schedulePatch({ ...commonOpts(), sid: "   ", name: "x" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toBe("schedule id is required\n");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no flags → exit 2 mentioning every supported flag, no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await schedulePatch({ ...commonOpts(), sid: SID });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("at least one of --name");
    expect(r.stderr).toContain("--cron");
    expect(r.stderr).toContain("--tz");
    expect(r.stderr).toContain("--agent");
    expect(r.stderr).toContain("--instructions");
    expect(r.stderr).toContain("--runtime");
    expect(r.stderr).toContain("--enabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("schedulePatch — server error envelopes", () => {
  it("PATCH 404 ScheduleNotFoundError → exit 4 with typed code in stderr", async () => {
    stubFetchMulti([
      { status: 200, body: JSON.stringify(sampleScheduleGet) },
      {
        status: 404,
        body: JSON.stringify({
          error: `schedule "${SID}" not found`,
          code: "ScheduleNotFoundError",
        }),
      },
    ]);
    const r = await schedulePatch({
      ...commonOpts(),
      sid: SID,
      cron: "0 10 * * *",
      json: true,
    });
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/ScheduleNotFoundError/);
    expect(r.stderr).toMatch(/HTTP 404/);
  });

  it("GET 404 surfaces the typed code (no follow-up PATCH issued)", async () => {
    const { calls } = stubFetchMulti([
      {
        status: 404,
        body: JSON.stringify({
          error: `schedule "${SID}" not found`,
          code: "ScheduleNotFoundError",
        }),
      },
    ]);
    const r = await schedulePatch({ ...commonOpts(), sid: SID, cron: "0 10 * * *" });
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/ScheduleNotFoundError/);
    // Critical: the merge-fetch failed, so no PATCH should be issued
    // — otherwise we'd be sending a body without a tz to the server.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
  });
});

describe("`emploke schedule patch` commander wiring (argv → action)", () => {
  function env(): Record<string, string | undefined> {
    return {
      EMPLOKE_HOME: home,
      EMPLOKE_SERVER: SERVER_URL,
      EMPLOKE_WORKSPACE: undefined,
    };
  }

  it("`--no-enabled` parses to enabled:false (parity with `schedule disable`)", async () => {
    const { calls } = stubFetchMulti([
      { status: 200, body: JSON.stringify({ ...sampleSchedule, enabled: false }) },
    ]);
    const r = await runCli(["schedule", "patch", SID, "--workspace", WSID, "--no-enabled"], env());
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ enabled: false });
  });

  it("`--enabled` parses to enabled:true (parity with `schedule enable`)", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleSchedule) }]);
    const r = await runCli(["schedule", "patch", SID, "--workspace", WSID, "--enabled"], env());
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ enabled: true });
  });

  it("no flags via argv → action prelude returns exit 2, no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await runCli(["schedule", "patch", SID, "--workspace", WSID], env());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("at least one of --name");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("--name + --cron + --tz routes through commander to a single PATCH", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleSchedule) }]);
    const r = await runCli(
      [
        "schedule",
        "patch",
        SID,
        "--workspace",
        WSID,
        "--name",
        "Renamed",
        "--cron",
        "0 10 * * *",
        "--tz",
        "UTC",
      ],
      env(),
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({
      name: "Renamed",
      trigger: { kind: "cron", expr: "0 10 * * *", tz: "UTC" },
    });
  });
});
