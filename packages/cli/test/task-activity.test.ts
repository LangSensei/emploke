/**
 * Unit tests for `followTaskActivity` — the SSE consumer used by
 * `emploke task activity <tid> --follow`.
 *
 * The test feeds a synthetic SSE Response (built around a
 * `ReadableStream` of UTF-8 frames) into a mock-fetch ApiClient, and
 * asserts:
 *  - `Last-Event-ID` is sent on the request iff the caller passes a
 *    `cursor`.
 *  - Each printed item lands on its own NDJSON line.
 *  - `event: end` exits 0; `event: error` exits 1 with stderr.
 *  - Whenever at least one frame carried `id:`, the result's stderr
 *    ends with `last seq: <N>` so the user can resume next time.
 */

import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/api-client.js";
import { followTaskActivity } from "../src/commands/task.js";

interface Captured {
  url: string;
  headers: Record<string, string>;
}

/**
 * Build a fake fetch returning a `text/event-stream` Response whose
 * body emits the given frames. Each `frame` is a complete SSE frame
 * (the function appends the trailing `\n\n`); frames are flushed in
 * separate `enqueue` calls to mirror what a real server does.
 */
function makeSseFetch(frames: readonly string[]): {
  fetchFn: typeof fetch;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    captured.push({ url: String(input), headers });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`${frame}\n\n`));
        }
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { fetchFn, captured };
}

function activityFrame(seq: number, payload: object): string {
  return `event: activity\nid: ${seq}\ndata: ${JSON.stringify({ seq, ...payload })}`;
}

describe("followTaskActivity", () => {
  it("does NOT send Last-Event-ID when called without a cursor", async () => {
    const { fetchFn, captured } = makeSseFetch(["event: end\ndata: {}"]);
    const client = new ApiClient({ baseUrl: "http://test.local", fetch: fetchFn });
    const r = await followTaskActivity(client, "ws-1", "20260601-abcd1234", undefined);
    expect(r.exitCode).toBe(0);
    expect(captured[0]?.headers["Last-Event-ID"]).toBeUndefined();
  });

  it("sends Last-Event-ID: <cursor> when a cursor is provided", async () => {
    const { fetchFn, captured } = makeSseFetch(["event: end\ndata: {}"]);
    const client = new ApiClient({ baseUrl: "http://test.local", fetch: fetchFn });
    await followTaskActivity(client, "ws-1", "20260601-abcd1234", 1234);
    expect(captured[0]?.headers["Last-Event-ID"]).toBe("1234");
  });

  it("emits one NDJSON line per activity frame and exits 0 on `end`", async () => {
    const { fetchFn } = makeSseFetch([
      activityFrame(1, { kind: "stdout", text: "hello" }),
      activityFrame(2, { kind: "stdout", text: "world" }),
      "event: end\ndata: {}",
    ]);
    const client = new ApiClient({ baseUrl: "http://test.local", fetch: fetchFn });
    const r = await followTaskActivity(client, "ws-1", "tid", undefined);
    expect(r.exitCode).toBe(0);
    const lines = (r.stdout ?? "").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ seq: 1, text: "hello" });
    expect(JSON.parse(lines[1] as string)).toMatchObject({ seq: 2, text: "world" });
  });

  it("appends `last seq: <N>` to stderr after a clean end", async () => {
    const { fetchFn } = makeSseFetch([
      activityFrame(7, { kind: "stdout", text: "x" }),
      activityFrame(8, { kind: "stdout", text: "y" }),
      "event: end\nid: 9\ndata: {}",
    ]);
    const client = new ApiClient({ baseUrl: "http://test.local", fetch: fetchFn });
    const r = await followTaskActivity(client, "ws-1", "tid", undefined);
    expect(r.exitCode).toBe(0);
    // The `end` frame's id wins because parseSseFrame updates lastSeq
    // BEFORE branching on event type — that's the most informative
    // resume hint (anything strictly less than 9 was already seen).
    expect(r.stderr).toBe("last seq: 9\n");
  });

  it("seeds lastSeq from the resume cursor when no frames carry id", async () => {
    // Server replays nothing because cursor was already at HEAD; the
    // hint should still echo the cursor so the user can re-resume
    // from the same point next time.
    const { fetchFn } = makeSseFetch(["event: end\ndata: {}"]);
    const client = new ApiClient({ baseUrl: "http://test.local", fetch: fetchFn });
    const r = await followTaskActivity(client, "ws-1", "tid", 42);
    expect(r.stderr).toBe("last seq: 42\n");
  });

  it("does NOT print a resume hint when no cursor and no frames had id", async () => {
    const { fetchFn } = makeSseFetch(["event: end\ndata: {}"]);
    const client = new ApiClient({ baseUrl: "http://test.local", fetch: fetchFn });
    const r = await followTaskActivity(client, "ws-1", "tid", undefined);
    expect(r.exitCode).toBe(0);
    expect(r.stderr ?? "").toBe("");
  });

  it("event: error exits 1, surfaces server message, and still prints last seq", async () => {
    const { fetchFn } = makeSseFetch([
      activityFrame(5, { kind: "stdout", text: "before fault" }),
      `event: error\ndata: ${JSON.stringify({ error: "runtime crashed" })}`,
    ]);
    const client = new ApiClient({ baseUrl: "http://test.local", fetch: fetchFn });
    const r = await followTaskActivity(client, "ws-1", "tid", undefined);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("stream error:");
    expect(r.stderr).toContain("runtime crashed");
    expect(r.stderr).toContain("last seq: 5");
  });

  it("404 returns exit 1 with a helpful message and no resume hint", async () => {
    const fetchFn: typeof fetch = async () =>
      new Response("not found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
    const client = new ApiClient({ baseUrl: "http://test.local", fetch: fetchFn });
    const r = await followTaskActivity(client, "ws-1", "missing", 99);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no streaming activity");
    // Resume hint suppressed — no events were ever delivered.
    expect(r.stderr).not.toContain("last seq:");
  });

  it("frames split across multiple chunks are reassembled correctly", async () => {
    // Real network reads don't honour frame boundaries; the parser
    // has to buffer until \n\n shows up. Simulate by chopping a
    // single frame in half.
    const captured: Captured[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k] = v;
        }
      }
      captured.push({ url: String(input), headers });
      const full = `${activityFrame(11, { text: "split" })}\n\nevent: end\ndata: {}\n\n`;
      const half = Math.floor(full.length / 2);
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(full.slice(0, half)));
          controller.enqueue(encoder.encode(full.slice(half)));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const client = new ApiClient({ baseUrl: "http://test.local", fetch: fetchFn });
    const r = await followTaskActivity(client, "ws-1", "tid", undefined);
    expect(r.exitCode).toBe(0);
    const lines = (r.stdout ?? "").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ seq: 11, text: "split" });
    expect(r.stderr).toBe("last seq: 11\n");
  });
});
