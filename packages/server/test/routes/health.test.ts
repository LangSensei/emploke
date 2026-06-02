import { describe, expect, it } from "vitest";
import { type HealthResponse, healthRoutes } from "../../src/routes/health.js";

describe("healthRoutes", () => {
  it("GET / returns status, name, version, startedAt, uptimeSec, serverNow", async () => {
    // Pinned clock so uptime is deterministic.
    const startedAtMs = Date.parse("2026-05-08T01:00:00.000Z");
    const nowMs = Date.parse("2026-05-08T01:00:42.500Z");
    const res = await healthRoutes({
      name: "@emploke/server",
      version: "1.2.3",
      startedAtMs,
      now: () => nowMs,
    }).request("/");

    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body).toEqual({
      status: "ok",
      name: "@emploke/server",
      version: "1.2.3",
      startedAt: "2026-05-08T01:00:00.000Z",
      // 42.5s rounds down to whole seconds.
      uptimeSec: 42,
      // Echoes the moment the response was formed; clients use this to
      // compute their clock skew against the server.
      serverNow: "2026-05-08T01:00:42.500Z",
    });
  });

  it("uptimeSec floors negative deltas to 0", async () => {
    // If `now()` somehow precedes startedAt (clock skew during tests, or
    // someone wires it backwards), we must not report a negative number.
    const startedAtMs = Date.parse("2026-05-08T01:00:00.000Z");
    const nowMs = Date.parse("2026-05-08T00:59:00.000Z");
    const res = await healthRoutes({
      name: "@emploke/server",
      version: "1.2.3",
      startedAtMs,
      now: () => nowMs,
    }).request("/");
    const body = (await res.json()) as HealthResponse;
    expect(body.uptimeSec).toBe(0);
  });

  it("status is always 'ok' (reserved enum)", async () => {
    const res = await healthRoutes({
      name: "n",
      version: "v",
      startedAtMs: Date.now(),
    }).request("/");
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe("ok");
  });
});
