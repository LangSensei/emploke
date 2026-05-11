import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { probeHealth, waitForHealth } from "../src/health-probe.js";

describe("health-probe", () => {
  let server: http.Server | null = null;
  let port = 0;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
  });

  async function listen(handler: http.RequestListener): Promise<number> {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (typeof addr === "object" && addr !== null) port = addr.port;
    return port;
  }

  it("returns the snapshot on a 200 with status: ok", async () => {
    const p = await listen((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          status: "ok",
          name: "@emploke/server",
          version: "0.1.0",
          startedAt: "2026-05-11T00:00:00.000Z",
          uptimeSec: 7,
          serverNow: "2026-05-11T00:00:07.000Z",
        }),
      );
    });
    const snap = await probeHealth({ host: "127.0.0.1", port: p });
    expect(snap?.status).toBe("ok");
    expect(snap?.version).toBe("0.1.0");
    expect(snap?.uptimeSec).toBe(7);
  });

  it("returns null on a non-200 response", async () => {
    const p = await listen((_req, res) => {
      res.statusCode = 500;
      res.end();
    });
    expect(await probeHealth({ host: "127.0.0.1", port: p })).toBeNull();
  });

  it("returns null on a 200 whose body is not status:ok", async () => {
    const p = await listen((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "degraded" }));
    });
    expect(await probeHealth({ host: "127.0.0.1", port: p })).toBeNull();
  });

  it("returns null on a connection refused (no server)", async () => {
    // 1 is reserved on most systems and won't have anything listening.
    expect(await probeHealth({ host: "127.0.0.1", port: 1, timeoutMs: 250 })).toBeNull();
  });

  it("returns null on timeout (server hangs)", async () => {
    const p = await listen((_req, _res) => {
      // never respond
    });
    const start = Date.now();
    expect(await probeHealth({ host: "127.0.0.1", port: p, timeoutMs: 200 })).toBeNull();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("waitForHealth retries until the server comes up", async () => {
    let calls = 0;
    const p = await listen((_req, res) => {
      calls += 1;
      if (calls < 3) {
        res.statusCode = 503;
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          status: "ok",
          name: "@emploke/server",
          version: "0.1.0",
          startedAt: "2026-05-11T00:00:00.000Z",
          uptimeSec: 1,
          serverNow: "2026-05-11T00:00:01.000Z",
        }),
      );
    });
    const snap = await waitForHealth({ host: "127.0.0.1", port: p, totalMs: 2000 });
    expect(snap?.status).toBe("ok");
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("waitForHealth returns null if the server never comes up", async () => {
    // Nothing listening on port 1; 600ms should be plenty for several retries.
    const start = Date.now();
    const snap = await waitForHealth({ host: "127.0.0.1", port: 1, totalMs: 600 });
    expect(snap).toBeNull();
    // Loop should not run wildly past the deadline.
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
