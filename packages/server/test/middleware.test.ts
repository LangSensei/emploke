import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessLog } from "../src/middleware/access-log.js";
import { requestId } from "../src/middleware/request-id.js";
import { requestLogger } from "../src/middleware/request-logger.js";
import { captureLogger } from "./_capture-logger.js";

/**
 * Tests for the observability middleware chain (issue #58):
 *   - request-id minting + x-request-id header
 *   - per-request child logger on c.var.logger
 *   - access log line per request with correct level + meta
 *
 * All hermetic — no real network, no real fs. Stubs pino via
 * `captureLogger` so assertions can introspect the structured entries.
 */

let cap: ReturnType<typeof captureLogger>;

beforeEach(() => {
  cap = captureLogger();
});

afterEach(() => {
  cap.entries.length = 0;
});

function buildApp() {
  const app = new Hono();
  app.use("*", requestId());
  app.use("*", requestLogger(cap.logger));
  app.use("*", accessLog());
  return app;
}

describe("requestId middleware", () => {
  it("mints an 8-char id when no header is present and echoes it back", async () => {
    const app = buildApp();
    app.get("/echo", (c) => c.json({ id: c.get("requestId") }));

    const res = await app.request("/echo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toMatch(/^[0-9a-f]{8}$/);
    expect(res.headers.get("x-request-id")).toBe(body.id);
  });

  it("honours a sane incoming x-request-id (used as correlation key)", async () => {
    const app = buildApp();
    app.get("/echo", (c) => c.json({ id: c.get("requestId") }));

    const res = await app.request("/echo", {
      headers: { "x-request-id": "trace-abc-123" },
    });
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("trace-abc-123");
    expect(res.headers.get("x-request-id")).toBe("trace-abc-123");
  });

  it("rejects garbage incoming x-request-id and mints fresh", async () => {
    const app = buildApp();
    app.get("/echo", (c) => c.json({ id: c.get("requestId") }));

    // Spaces and other characters outside `[\w.-_]` should NOT survive
    // — keeping ids opaque means a forged header can't sneak structured
    // characters into log greps. (Newline injection is also blocked,
    // but that's caught earlier by Hono itself which refuses to
    // construct a Headers object with control chars in a value.)
    const res = await app.request("/echo", {
      headers: { "x-request-id": "id with spaces" },
    });
    const body = (await res.json()) as { id: string };
    expect(body.id).toMatch(/^[0-9a-f]{8}$/);
    expect(body.id).not.toContain("spaces");
  });
});

describe("requestLogger middleware", () => {
  it("binds requestId on c.var.logger so route logs inherit it", async () => {
    const app = buildApp();
    app.get("/log", (c) => {
      c.get("logger").info("from route");
      return c.text("ok");
    });

    await app.request("/log", { headers: { "x-request-id": "req-xyz" } });
    const fromRoute = cap.entries.find((e) => e.msg === "from route");
    expect(fromRoute).toBeDefined();
    expect(fromRoute?.requestId).toBe("req-xyz");
  });
});

describe("accessLog middleware", () => {
  it("emits one info line per successful request with method/path/status/durationMs", async () => {
    const app = buildApp();
    app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));

    await app.request("/users/42");
    const access = cap.entries.find((e) => e.msg === "http");
    expect(access).toBeDefined();
    expect(access?.level).toBe(30); // info
    expect(access?.method).toBe("GET");
    expect(access?.status).toBe(200);
    expect(access?.path).toBe("/users/:id"); // route template, not the actual path
    expect(typeof access?.durationMs).toBe("number");
  });

  it("emits warn for 4xx", async () => {
    const app = buildApp();
    app.get("/missing", (c) => c.json({ error: "not found" }, 404));

    await app.request("/missing");
    const access = cap.entries.find((e) => e.msg === "http");
    expect(access?.level).toBe(40); // warn
    expect(access?.status).toBe(404);
  });

  it("emits error for 5xx", async () => {
    const app = buildApp();
    app.get("/boom", (c) => c.json({ error: "internal" }, 500));

    await app.request("/boom");
    const access = cap.entries.find((e) => e.msg === "http");
    expect(access?.level).toBe(50); // error
    expect(access?.status).toBe(500);
  });

  it("skips /api/health to keep poll-loop noise down", async () => {
    const app = buildApp();
    app.get("/api/health", (c) => c.json({ ok: true }));

    await app.request("/api/health");
    const access = cap.entries.find((e) => e.msg === "http");
    expect(access).toBeUndefined();
  });

  it("includes workspaceId from :id URL param when present", async () => {
    const app = buildApp();
    app.get("/api/workspaces/:id/sessions", (c) => c.json([]));

    await app.request("/api/workspaces/ws-abc-123/sessions");
    const access = cap.entries.find((e) => e.msg === "http");
    expect(access?.workspaceId).toBe("ws-abc-123");
  });

  it("truncates oversized user-agent header", async () => {
    const app = buildApp();
    app.get("/", (c) => c.text("ok"));

    const longUA = "Mozilla/5.0 ".padEnd(200, "x");
    await app.request("/", { headers: { "user-agent": longUA } });
    const access = cap.entries.find((e) => e.msg === "http");
    expect(typeof access?.userAgent).toBe("string");
    expect((access?.userAgent as string).length).toBeLessThanOrEqual(80);
  });

  it("escalates to warn when a 2xx response takes longer than the slow-request threshold", async () => {
    // Drive the duration via `performance.now` rather than a real wait so
    // the test stays fast. accessLog reads `performance.now()` exactly
    // twice (start, finally); we return a small first value then jump
    // past the 2s threshold on the second read.
    const original = performance.now.bind(performance);
    let call = 0;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => {
      call++;
      // First call: t=0 (start of access middleware).
      // Second call: t=2500 (in finally — after next()).
      // Third+ calls: real time, in case anything else reads.
      if (call === 1) return 0;
      if (call === 2) return 2500;
      return original();
    });
    try {
      const app = buildApp();
      app.get("/slow", (c) => c.text("done"));
      const res = await app.request("/slow");
      expect(res.status).toBe(200);
      const access = cap.entries.find((e) => e.msg === "http");
      expect(access?.level).toBe(40); // warn — slow but successful
      expect(access?.status).toBe(200);
      expect(access?.durationMs).toBeGreaterThan(2000);
    } finally {
      spy.mockRestore();
    }
  });

  it("still emits an access line with error level when a downstream handler throws", async () => {
    // Defence-in-depth: Hono's default error handler catches the throw
    // and converts it to a generic 500 — so by the time our access
    // middleware's `finally` block runs, the response status is 500
    // and the `thrown` flag never gets set. The visible behaviour is
    // identical to "handler returned 500" — what we want to verify is
    // that an exception in the handler chain does NOT prevent the
    // access line from being emitted.
    const app = buildApp();
    app.get("/throws", () => {
      throw new Error("downstream-throw-sentinel");
    });

    const res = await app.request("/throws");
    expect(res.status).toBe(500); // Hono's default error response
    const access = cap.entries.find((e) => e.msg === "http");
    expect(access).toBeDefined();
    expect(access?.level).toBe(50); // error
    expect(access?.status).toBe(500);
  });
});
