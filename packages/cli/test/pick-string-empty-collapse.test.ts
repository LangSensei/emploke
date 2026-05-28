/**
 * Lock the documented `pickString` contract end-to-end via the public
 * CLI surface: for every string flag, `--flag ""` is silently equivalent
 * to omitting `--flag`. The collapse is implemented once in `pickString`
 * (see `packages/cli/src/index.ts`) and intentionally uniform across
 * ~50 flag sites; per-flag exceptions are explicitly rejected as ugly
 * asymmetry.
 *
 * These tests exercise the two flags most likely to surprise users —
 * `--details` on `task dispatch` and on `schedule create` — by issuing
 * the CLI with and without `--details ""` and asserting the captured
 * wire body is byte-for-byte identical. If anyone ever refactors
 * `pickString` to stop collapsing empty strings, both assertions will
 * regress.
 *
 * Uses the same `vi.spyOn(globalThis, "fetch")` pattern as
 * `api-contract.test.ts` and `schedule-patch.test.ts` — no new mocking
 * library.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runCli } from "./_helpers/run-cli.js";

const SERVER_URL = "http://stub.local";
const WSID = "ws-pick-string";

let home: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "emploke-cli-pick-string-"));
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
  body: unknown;
}

/**
 * Install a fetch stub that records the URL + method + parsed JSON body
 * of every request and returns the same canned response each time. The
 * response is intentionally minimal — these tests only care about the
 * outgoing wire body, not the rendered output.
 */
function stubFetch(response: { status: number; body: string }): { calls: Capture[] } {
  const calls: Capture[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
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
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  });
  return { calls };
}

function env(): Record<string, string | undefined> {
  return {
    EMPLOKE_HOME: home,
    EMPLOKE_SERVER: SERVER_URL,
    EMPLOKE_WORKSPACE: undefined,
  };
}

describe("CLI empty-string normalisation (pickString contract)", () => {
  // The dispatched task's wire shape (mirrors `taskDispatch` in
  // packages/cli/src/commands/task.ts:113): a fake response just needs
  // enough fields to keep `formatJson` happy on the success path.
  const taskResponse = {
    status: 201,
    body: JSON.stringify({
      id: "20260528-aaaaaaaa",
      agent: "emploke/dev",
      brief: "test",
      status: "queued",
    }),
  };

  it('task dispatch: --details "" produces an identical wire body to omitting --details', async () => {
    const a = stubFetch(taskResponse);
    const ra = await runCli(
      [
        "task",
        "dispatch",
        "--workspace",
        WSID,
        "--agent",
        "emploke/dev",
        "--brief",
        "test",
        "--details",
        "",
        "--json",
      ],
      env(),
    );
    expect(ra.exitCode, ra.stderr).toBe(0);
    expect(a.calls).toHaveLength(1);
    const bodyWithEmpty = a.calls[0]?.body as Record<string, unknown>;

    vi.restoreAllMocks();

    const b = stubFetch(taskResponse);
    const rb = await runCli(
      [
        "task",
        "dispatch",
        "--workspace",
        WSID,
        "--agent",
        "emploke/dev",
        "--brief",
        "test",
        "--json",
      ],
      env(),
    );
    expect(rb.exitCode, rb.stderr).toBe(0);
    expect(b.calls).toHaveLength(1);
    const bodyOmitted = b.calls[0]?.body as Record<string, unknown>;

    expect(bodyWithEmpty).toEqual(bodyOmitted);
    // `task dispatch`'s wire body is flat: details is a top-level field.
    expect(Object.hasOwn(bodyWithEmpty, "details")).toBe(false);
  });

  // The created schedule's wire shape (mirrors `scheduleCreate` in
  // packages/cli/src/commands/schedule.ts:128): the response only
  // needs to deserialise cleanly.
  const scheduleResponse = {
    status: 201,
    body: JSON.stringify({
      id: "20260528-bbbbbbbb",
      name: "s1",
      target: { kind: "task", agent: "emploke/dev", brief: "b" },
      trigger: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      enabled: true,
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:00.000Z",
    }),
  };

  it('schedule create: --details "" produces an identical wire body to omitting --details', async () => {
    const a = stubFetch(scheduleResponse);
    const ra = await runCli(
      [
        "schedule",
        "create",
        "--workspace",
        WSID,
        "--name",
        "s1",
        "--cron",
        "0 * * * *",
        "--tz",
        "UTC",
        "--agent",
        "emploke/dev",
        "--brief",
        "b",
        "--details",
        "",
        "--json",
      ],
      env(),
    );
    expect(ra.exitCode, ra.stderr).toBe(0);
    expect(a.calls).toHaveLength(1);
    const bodyWithEmpty = a.calls[0]?.body as { target: Record<string, unknown> };

    vi.restoreAllMocks();

    const b = stubFetch(scheduleResponse);
    const rb = await runCli(
      [
        "schedule",
        "create",
        "--workspace",
        WSID,
        "--name",
        "s1",
        "--cron",
        "0 * * * *",
        "--tz",
        "UTC",
        "--agent",
        "emploke/dev",
        "--brief",
        "b",
        "--json",
      ],
      env(),
    );
    expect(rb.exitCode, rb.stderr).toBe(0);
    expect(b.calls).toHaveLength(1);
    const bodyOmitted = b.calls[0]?.body as { target: Record<string, unknown> };

    expect(bodyWithEmpty).toEqual(bodyOmitted);
    // `schedule create`'s wire body nests the task fields under `target`,
    // so the absent-details assertion lives one level deeper than in
    // the `task dispatch` case above.
    expect(Object.hasOwn(bodyWithEmpty.target, "details")).toBe(false);
  });
});
