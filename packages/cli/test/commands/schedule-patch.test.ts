/**
 * `emploke schedule patch` — general partial-update CLI surface.
 *
 * Calls `schedulePatch(...)` directly with a `vi.spyOn(globalThis,
 * "fetch")` stub so the full action body — including the one-remaining
 * fetch-merge-send round-trip for partial trigger updates — exercises
 * real production code rather than an inline re-implementation.
 *
 * ## Why the GET-merge cycle is mostly gone
 *
 * After the kind-discriminated routes refactor (`PATCH
 * /schedules/task/:sid`), the server deep-merges `target` per RFC
 * 7396. That means sparse target updates (e.g. `--brief x`) ship a
 * single PATCH with `{target:{brief:"x"}}` — no GET, no merge.
 *
 * `trigger` remains wholesale-replace (small atomic shape). The only
 * remaining GET-merge case is a partial trigger update (--cron OR --tz,
 * but not both) where the CLI must read the existing trigger to fill
 * the missing field.
 *
 * `--clear-details` / `--clear-runtime` ship `null` on the wire (RFC
 * 7396 delete) — distinct from `--details ""` (set to empty string).
 *
 * Pairs with: `task-cancel.test.ts` (mock-fetch verb pattern),
 * `api-contract.test.ts` (full-pipeline pattern via `runCli`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { schedulePatch } from "../../src/commands/schedule.js";
import { runCli } from "../_helpers/run-cli.js";

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
    brief: "do the thing",
    details: "Long body for the daily brief task.",
    runtime: "copilot",
  },
  enabled: true,
  createdAt: "2026-05-27T00:00:00.000Z",
  updatedAt: "2026-05-27T00:00:00.000Z",
};

const sampleScheduleGet = { ...sampleSchedule, describe: "every day at 9" };

function commonOpts() {
  return { workspace: WSID, server: SERVER_URL, home };
}

// PATCH is on the kind-discriminated URL; GET stays polymorphic.
const PATCH_URL = `${SERVER_URL}/api/workspaces/${WSID}/schedules/task/${SID}`;
const GET_URL = `${SERVER_URL}/api/workspaces/${WSID}/schedules/${SID}`;

describe("schedulePatch — single-field fast path (one PATCH, no GET)", () => {
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
    expect(calls[0]?.url).toBe(PATCH_URL);
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

describe("schedulePatch — sparse trigger updates", () => {
  // Trigger is wholesale-replace server-side, so a partial trigger
  // update (one of --cron / --tz) still requires a GET to fill the
  // other field. This is the only remaining GET-merge case.

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
    expect(calls[1]?.url).toBe(PATCH_URL);
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
    expect(calls[0]?.url).toBe(PATCH_URL);
    expect(calls[0]?.body).toEqual({
      trigger: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
    });
  });
});

describe("schedulePatch — sparse target updates (single PATCH, server deep-merges)", () => {
  // No GET: the server deep-merges target per field, so the CLI ships
  // only the named fields.

  it("--agent alone sends sparse target", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleSchedule) }]);
    const r = await schedulePatch({ ...commonOpts(), sid: SID, agent: "emploke/qa" });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe(PATCH_URL);
    expect(calls[0]?.body).toEqual({ target: { agent: "emploke/qa" } });
  });

  it("--brief alone sends sparse target with trimmed brief", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleSchedule) }]);
    const r = await schedulePatch({
      ...commonOpts(),
      sid: SID,
      brief: "renamed brief",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ target: { brief: "renamed brief" } });
  });

  it("--details alone sends sparse target (multi-line value allowed)", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleSchedule) }]);
    const r = await schedulePatch({
      ...commonOpts(),
      sid: SID,
      details: "new details\n- a\n- b",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({
      target: { details: "new details\n- a\n- b" },
    });
  });

  it("--clear-details sends target.details: null (RFC 7396 delete)", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleSchedule) }]);
    const r = await schedulePatch({ ...commonOpts(), sid: SID, clearDetails: true });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ target: { details: null } });
  });

  it("--details and --clear-details together → exit 2 (mutually exclusive)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await schedulePatch({
      ...commonOpts(),
      sid: SID,
      details: "x",
      clearDetails: true,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/mutually exclusive/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("--runtime alone sends sparse target", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleSchedule) }]);
    const r = await schedulePatch({ ...commonOpts(), sid: SID, runtime: "echo" });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ target: { runtime: "echo" } });
  });

  it("--clear-runtime sends target.runtime: null (RFC 7396 delete)", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleSchedule) }]);
    const r = await schedulePatch({ ...commonOpts(), sid: SID, clearRuntime: true });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ target: { runtime: null } });
  });

  it("--runtime and --clear-runtime together → exit 2 (mutually exclusive)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await schedulePatch({
      ...commonOpts(),
      sid: SID,
      runtime: "x",
      clearRuntime: true,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/mutually exclusive/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("--agent + --brief send a single PATCH with both fields (no GET)", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleSchedule) }]);
    const r = await schedulePatch({
      ...commonOpts(),
      sid: SID,
      agent: "emploke/qa",
      brief: "go",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe(PATCH_URL);
    expect(calls[0]?.body).toEqual({
      target: { agent: "emploke/qa", brief: "go" },
    });
  });

  it("--clear-details + --runtime combine into one sparse target body", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleSchedule) }]);
    const r = await schedulePatch({
      ...commonOpts(),
      sid: SID,
      clearDetails: true,
      runtime: "echo",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      target: { details: null, runtime: "echo" },
    });
  });

  it("--clear-details + --clear-runtime ships both nulls in one PATCH (deletes both optional fields)", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleSchedule) }]);
    const r = await schedulePatch({
      ...commonOpts(),
      sid: SID,
      clearDetails: true,
      clearRuntime: true,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({
      target: { details: null, runtime: null },
    });
  });
});

describe("schedulePatch — --brief content validation (no fetch)", () => {
  it("--brief with newline → exit 2", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await schedulePatch({ ...commonOpts(), sid: SID, brief: "foo\nbar" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/single line/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("--brief over 200 chars → exit 2", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await schedulePatch({ ...commonOpts(), sid: SID, brief: "x".repeat(201) });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/200/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("--brief whitespace only → exit 2", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await schedulePatch({ ...commonOpts(), sid: SID, brief: "   " });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/non-empty/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("schedulePatch — combined fields", () => {
  it("name + full trigger + sparse target → one PATCH (no GET)", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleSchedule) }]);
    const r = await schedulePatch({
      ...commonOpts(),
      sid: SID,
      name: "All-At-Once",
      cron: "0 12 * * *",
      tz: "UTC",
      agent: "emploke/qa",
      brief: "go",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe(PATCH_URL);
    expect(calls[0]?.body).toEqual({
      name: "All-At-Once",
      trigger: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
      target: { agent: "emploke/qa", brief: "go" },
    });
  });

  it("name + partial trigger + sparse target → GET (for trigger) + PATCH", async () => {
    const { calls } = stubFetchMulti([
      { status: 200, body: JSON.stringify(sampleScheduleGet) },
      { status: 200, body: JSON.stringify(sampleSchedule) },
    ]);
    const r = await schedulePatch({
      ...commonOpts(),
      sid: SID,
      name: "Renamed",
      cron: "0 12 * * *",
      brief: "go",
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.body).toEqual({
      name: "Renamed",
      trigger: { kind: "cron", expr: "0 12 * * *", tz: "Asia/Shanghai" },
      target: { brief: "go" },
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
    expect(r.stderr).toContain("--brief");
    expect(r.stderr).toContain("--details");
    expect(r.stderr).toContain("--clear-details");
    expect(r.stderr).toContain("--runtime");
    expect(r.stderr).toContain("--clear-runtime");
    expect(r.stderr).toContain("--enabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("schedulePatch — server error envelopes", () => {
  it("PATCH 404 ScheduleNotFoundError → exit 4 with typed code in stderr", async () => {
    stubFetchMulti([
      // For --cron alone, the GET runs first (to fill tz).
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

  it("--clear-details routes through commander to a PATCH with target.details: null", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleSchedule) }]);
    const r = await runCli(
      ["schedule", "patch", SID, "--workspace", WSID, "--clear-details"],
      env(),
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ target: { details: null } });
  });

  it("--clear-runtime routes through commander to a PATCH with target.runtime: null", async () => {
    const { calls } = stubFetchMulti([{ status: 200, body: JSON.stringify(sampleSchedule) }]);
    const r = await runCli(
      ["schedule", "patch", SID, "--workspace", WSID, "--clear-runtime"],
      env(),
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ target: { runtime: null } });
  });
});
