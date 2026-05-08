import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { assertBindIsSafe, bearerAuth, constantTimeEqual, isLoopbackBind } from "../src/auth.js";

describe("isLoopbackBind", () => {
  it.each([
    ["127.0.0.1", true],
    ["localhost", true],
    ["::1", true],
    ["[::1]", true],
    ["127.5.0.1", true],
    ["0.0.0.0", false],
    ["192.168.1.10", false],
    ["10.0.0.5", false],
    ["example.com", false],
    ["", false],
  ])("classifies %s as %s", (host, expected) => {
    expect(isLoopbackBind(host)).toBe(expected);
  });
});

describe("assertBindIsSafe", () => {
  it("allows loopback bind without an API key", () => {
    expect(() => assertBindIsSafe("127.0.0.1", undefined)).not.toThrow();
    expect(() => assertBindIsSafe("localhost", "")).not.toThrow();
  });

  it("allows non-loopback bind when API key is set", () => {
    expect(() => assertBindIsSafe("0.0.0.0", "secret-token-123")).not.toThrow();
    expect(() => assertBindIsSafe("192.168.1.10", "k")).not.toThrow();
  });

  it("refuses non-loopback bind without API key (fail-closed)", () => {
    expect(() => assertBindIsSafe("0.0.0.0", undefined)).toThrow(/Refusing to bind/);
    expect(() => assertBindIsSafe("0.0.0.0", "")).toThrow(/Refusing to bind/);
    expect(() => assertBindIsSafe("0.0.0.0", "   ")).toThrow(/Refusing to bind/);
  });

  it("includes both remediation paths in the error", () => {
    try {
      assertBindIsSafe("10.0.0.1", undefined);
      expect.fail("should have thrown");
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain("EMPLOKE_HOST=127.0.0.1");
      expect(m).toContain("EMPLOKE_API_KEY");
    }
  });
});

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("hello", "hello")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("returns false for different lengths", () => {
    expect(constantTimeEqual("a", "ab")).toBe(false);
    expect(constantTimeEqual("ab", "a")).toBe(false);
  });

  it("returns false for same length, different content", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("xyz", "abc")).toBe(false);
  });
});

describe("bearerAuth middleware", () => {
  function makeApp(key: string): Hono {
    const app = new Hono();
    app.use("/api/*", bearerAuth(key));
    app.get("/api/ok", (c) => c.json({ ok: true }));
    return app;
  }

  it("allows requests with the correct Bearer token", async () => {
    const app = makeApp("secret-key");
    const res = await app.request("/api/ok", {
      headers: { authorization: "Bearer secret-key" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("allows requests with the correct apiKey query param", async () => {
    const app = makeApp("secret-key");
    const res = await app.request("/api/ok?apiKey=secret-key");
    expect(res.status).toBe(200);
  });

  it("rejects requests with no auth", async () => {
    const app = makeApp("secret-key");
    const res = await app.request("/api/ok");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", code: "Unauthorized" });
  });

  it("rejects requests with the wrong Bearer token", async () => {
    const app = makeApp("secret-key");
    const res = await app.request("/api/ok", {
      headers: { authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with a too-short presented key", async () => {
    const app = makeApp("secret-key");
    const res = await app.request("/api/ok", {
      headers: { authorization: "Bearer s" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts case-insensitive 'Bearer' scheme", async () => {
    const app = makeApp("secret-key");
    const res = await app.request("/api/ok", {
      headers: { authorization: "bearer secret-key" },
    });
    expect(res.status).toBe(200);
  });

  it("ignores non-Bearer authorization schemes", async () => {
    const app = makeApp("secret-key");
    const res = await app.request("/api/ok", {
      headers: { authorization: "Basic c2VjcmV0LWtleQ==" },
    });
    expect(res.status).toBe(401);
  });
});
