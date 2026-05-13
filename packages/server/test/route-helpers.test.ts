import { captureLogger } from "@emploke/logger/testing";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestId } from "../src/middleware/request-id.js";
import { requestLogger } from "../src/middleware/request-logger.js";
import { logEvent, logFault } from "../src/routes/_shared.js";

/**
 * Tests for the `logEvent` / `logFault` helpers. Both surface the
 * request-scoped logger so state-mutating routes can ship a single
 * structured success line ("workspace created", "agent removed", etc.)
 * or a structured 5xx fault — without each route having to declare the
 * `Variables: { logger }` env up-front.
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
  return app;
}

describe("logEvent helper", () => {
  it("emits a single info line at the success boundary, with meta", async () => {
    const app = buildApp();
    app.post("/things", (c) => {
      logEvent(c, "thing created", { id: "thing-1", kind: "demo" });
      return c.json({ id: "thing-1" }, 201);
    });

    const res = await app.request("/things", {
      method: "POST",
      headers: { "x-request-id": "req-evt" },
    });
    expect(res.status).toBe(201);

    const evt = cap.entries.find((e) => e.msg === "thing created");
    expect(evt).toBeDefined();
    expect(evt?.level).toBe(30); // info
    expect(evt?.id).toBe("thing-1");
    expect(evt?.kind).toBe("demo");
    // Inherits requestId binding from the request-scoped child logger.
    expect(evt?.requestId).toBe("req-evt");
  });

  it("works with no meta arg (allows simplest call sites)", async () => {
    const app = buildApp();
    app.post("/ping", (c) => {
      logEvent(c, "pinged");
      return c.text("ok");
    });

    await app.request("/ping", { method: "POST" });
    const evt = cap.entries.find((e) => e.msg === "pinged");
    expect(evt?.level).toBe(30);
  });

  it("is a silent no-op when no logger is bound on the context", async () => {
    // Mount the route WITHOUT the requestLogger middleware so c.var.logger
    // is undefined. The helper must not throw — preserves the test seam
    // for unit tests that mount route factories directly.
    const app = new Hono();
    app.post("/safe", (c) => {
      logEvent(c, "should not throw", { foo: "bar" });
      return c.text("ok");
    });

    const res = await app.request("/safe", { method: "POST" });
    expect(res.status).toBe(200);
    expect(cap.entries.find((e) => e.msg === "should not throw")).toBeUndefined();
  });
});

describe("logFault helper", () => {
  it("emits an error line with serialised err + extra meta", async () => {
    const app = buildApp();
    app.get("/oops", (c) => {
      logFault(c, new TypeError("nope"), "thing failed", { entityId: "x-1" });
      return c.json({ error: "internal" }, 500);
    });

    await app.request("/oops");
    const fault = cap.entries.find((e) => e.msg === "thing failed");
    expect(fault).toBeDefined();
    expect(fault?.level).toBe(50); // error
    expect(fault?.entityId).toBe("x-1");
    // errorMeta packs the error into an `err` field.
    const errMeta = fault?.err as { name: string; message: string };
    expect(errMeta.name).toBe("TypeError");
    expect(errMeta.message).toBe("nope");
  });

  it("is a silent no-op when no logger is bound (test seam preserved)", async () => {
    const app = new Hono();
    app.get("/bare", (c) => {
      logFault(c, new Error("boom"), "boom occurred");
      return c.text("ok");
    });

    const res = await app.request("/bare");
    expect(res.status).toBe(200);
    expect(cap.entries.find((e) => e.msg === "boom occurred")).toBeUndefined();
  });
});
