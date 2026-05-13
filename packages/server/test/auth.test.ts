import { captureLogger } from "@emploke/logger/testing";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { assertBindIsSafe, bearerAuth, constantTimeEqual, isLoopbackBind } from "../src/auth.js";
import { requestId } from "../src/middleware/request-id.js";
import { requestLogger } from "../src/middleware/request-logger.js";

describe("isLoopbackBind", () => {
  it.each([
    ["127.0.0.1", true],
    ["localhost", true],
    ["::1", true],
    ["[::1]", true],
    ["127.5.0.1", true],
    ["0.0.0.0", false],
    ["::", false], // IPv6 wildcard — bind-all-interfaces, NOT loopback
    ["0", false], // shorthand for 0.0.0.0
    ["192.168.1.10", false],
    ["10.0.0.5", false],
    ["example.com", false],
    ["", false],
    ["127.evil.com", true], // KNOWN LIMITATION: literal startsWith match;
    // a hostname starting with "127." is treated as loopback. We accept
    // this because (a) admins type literal IPs / "localhost", not weird
    // hostnames, and (b) the bind happens against this exact string —
    // OS resolves it at bind time, not us.
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

describe("bearerAuth — auth event logging (issue #58)", () => {
  /**
   * The auth middleware emits a `warn`-level structured log line for
   * every rejected request when a request-scoped logger is on the
   * Hono context. Tests below mount `requestId + requestLogger +
   * bearerAuth` (the same chain `index.ts` builds at boot) and
   * inspect the captured pino entries.
   *
   * Critical security invariant under test: the presented key is
   * NEVER logged — only its `length` and a `mode` discriminator
   * (`"header" | "query" | "absent"`). A leaky log would itself
   * become a credential channel.
   */
  function makeAuditedApp(key: string, logger: ReturnType<typeof captureLogger>["logger"]) {
    const app = new Hono();
    app.use("*", requestId());
    app.use("*", requestLogger(logger));
    app.use("/api/*", bearerAuth(key));
    app.get("/api/ok", (c) => c.json({ ok: true }));
    return app;
  }

  it("emits one warn line on auth failure with sanitised meta", async () => {
    const cap = captureLogger();
    const app = makeAuditedApp("secret-key", cap.logger);

    const res = await app.request("/api/ok", {
      headers: { authorization: "Bearer wrong-key", "user-agent": "vitest/1.0" },
    });
    expect(res.status).toBe(401);

    const w = cap.entries.find((e) => e.msg === "auth: bearer check failed");
    expect(w, "expected auth-failure log line").toBeDefined();
    expect(w?.level).toBe(40); // warn
    expect(w?.path).toBe("/api/ok");
    expect(w?.method).toBe("GET");
    expect(w?.credentialMode).toBe("header");
    expect(w?.credentialLen).toBe("wrong-key".length);
    expect(w?.userAgent).toBe("vitest/1.0");
    expect(typeof w?.requestId).toBe("string"); // bound by requestLogger
  });

  it("records absent credentials as credentialMode: 'absent'", async () => {
    const cap = captureLogger();
    const app = makeAuditedApp("secret-key", cap.logger);
    await app.request("/api/ok");
    const w = cap.entries.find((e) => e.msg === "auth: bearer check failed");
    expect(w?.credentialMode).toBe("absent");
    expect(w?.credentialLen).toBe(0);
  });

  it("records query credentials as credentialMode: 'query'", async () => {
    const cap = captureLogger();
    const app = makeAuditedApp("secret-key", cap.logger);
    await app.request("/api/ok?apiKey=wrong-via-query");
    const w = cap.entries.find((e) => e.msg === "auth: bearer check failed");
    expect(w?.credentialMode).toBe("query");
    expect(w?.credentialLen).toBe("wrong-via-query".length);
  });

  it("NEVER logs the presented key value (security regression)", async () => {
    const cap = captureLogger();
    const app = makeAuditedApp("secret-key", cap.logger);

    const sentinel = "supersecret_should_not_appear_in_logs_424242";
    await app.request("/api/ok", {
      headers: { authorization: `Bearer ${sentinel}` },
    });

    // Walk every captured entry's serialised JSON and assert the
    // sentinel never appears anywhere — not in `msg`, not in `meta`,
    // not in any field a future refactor might inadvertently add.
    const haystack = JSON.stringify(cap.entries);
    expect(haystack).not.toContain(sentinel);
    expect(haystack).not.toContain("supersecret");
  });

  it("does NOT emit an auth-failure line on successful auth", async () => {
    const cap = captureLogger();
    const app = makeAuditedApp("secret-key", cap.logger);
    const res = await app.request("/api/ok", {
      headers: { authorization: "Bearer secret-key" },
    });
    expect(res.status).toBe(200);
    const w = cap.entries.find((e) => e.msg === "auth: bearer check failed");
    expect(w).toBeUndefined();
  });
});
