import { describe, expect, it } from "vitest";
import { assertBindIsSafe, isLoopbackBind } from "../src/auth.js";

describe("isLoopbackBind", () => {
  it("recognises 127.0.0.1", () => {
    expect(isLoopbackBind("127.0.0.1")).toBe(true);
  });

  it("recognises localhost", () => {
    expect(isLoopbackBind("localhost")).toBe(true);
  });

  it("recognises ::1 and bracketed [::1]", () => {
    expect(isLoopbackBind("::1")).toBe(true);
    expect(isLoopbackBind("[::1]")).toBe(true);
  });

  it("recognises any 127.x.x.x address", () => {
    expect(isLoopbackBind("127.0.0.2")).toBe(true);
    expect(isLoopbackBind("127.255.255.255")).toBe(true);
  });

  it("rejects 0.0.0.0 (wildcard, network-reachable)", () => {
    expect(isLoopbackBind("0.0.0.0")).toBe(false);
  });

  it("rejects LAN / public addresses", () => {
    expect(isLoopbackBind("192.168.1.10")).toBe(false);
    expect(isLoopbackBind("10.0.0.5")).toBe(false);
    expect(isLoopbackBind("emploke.example.com")).toBe(false);
  });
});

describe("assertBindIsSafe", () => {
  it("allows loopback bind", () => {
    expect(() => assertBindIsSafe("127.0.0.1")).not.toThrow();
    expect(() => assertBindIsSafe("localhost")).not.toThrow();
    expect(() => assertBindIsSafe("::1")).not.toThrow();
  });

  it("refuses non-loopback bind (fail-closed)", () => {
    // The previous Bearer-token escape hatch was removed (issue #98
    // follow-up): emploke does not ship its own auth layer; remote
    // access must terminate auth at a layer designed for it
    // (SSH port-forward, reverse proxy with mTLS / OIDC, mesh VPN).
    expect(() => assertBindIsSafe("0.0.0.0")).toThrow(/Refusing to bind to 0\.0\.0\.0/);
    expect(() => assertBindIsSafe("192.168.1.10")).toThrow(/Refusing to bind to 192\.168\.1\.10/);
    expect(() => assertBindIsSafe("emploke.example.com")).toThrow(
      /Refusing to bind to emploke\.example\.com/,
    );
  });

  it("includes the three remediation paths in the error", () => {
    let caught: Error | undefined;
    try {
      assertBindIsSafe("0.0.0.0");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain("SSH port-forward");
    expect(caught?.message).toContain("Reverse proxy");
    expect(caught?.message).toContain("Mesh VPN");
    expect(caught?.message).toContain("EMPLOKE_HOST=127.0.0.1");
  });
});
