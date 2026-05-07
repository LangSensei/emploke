import { describe, expect, it } from "vitest";
import { InvalidSessionIdError } from "../src/errors.js";
import { assertValidSessionId, generateSessionId, SESSION_ID_RE } from "../src/ids.js";

describe("session id", () => {
  it("matches the canonical format", () => {
    const id = generateSessionId(
      () => new Date(2026, 4, 8, 1, 5, 0),
      (n) => Buffer.from("9dfbdf05".padEnd(n * 2, "0"), "hex"),
    );
    expect(id).toBe("20260508-010500-9dfbdf05");
    expect(SESSION_ID_RE.test(id)).toBe(true);
  });

  it("pads single-digit fields", () => {
    const id = generateSessionId(
      () => new Date(2026, 0, 1, 0, 0, 0),
      (n) => Buffer.alloc(n, 0xab),
    );
    // Jan = month 1 → "01"; day "01"; hh/mm/ss "00".
    expect(id).toBe("20260101-000000-abababab");
  });

  it("two ids in the same second differ by random suffix", () => {
    const t = new Date(2026, 4, 8, 1, 5, 0);
    let counter = 0;
    const rand = (n: number) => {
      counter++;
      return Buffer.alloc(n, counter);
    };
    const a = generateSessionId(() => t, rand);
    const b = generateSessionId(() => t, rand);
    expect(a).not.toBe(b);
    expect(a.slice(0, 16)).toBe(b.slice(0, 16));
  });

  it("default generator produces a valid id", () => {
    const id = generateSessionId();
    expect(SESSION_ID_RE.test(id)).toBe(true);
  });
});

describe("assertValidSessionId", () => {
  it("accepts canonical ids", () => {
    expect(() => assertValidSessionId("20260508-010500-9dfbdf05")).not.toThrow();
  });

  it.each([
    "20260508-010500-9DFBDF05", // upper-case hex
    "20260508-010500-9dfbdf0", // 7 chars
    "20260508-010500-9dfbdf055", // 9 chars
    "20260508-010500-zzzzzzzz", // non-hex
    "2026-05-08-010500-9dfbdf05", // wrong date sep
    "../escape", // traversal
    "", // empty
    "20260508-010500", // missing suffix
  ])("rejects malformed id %s", (id) => {
    expect(() => assertValidSessionId(id)).toThrow(InvalidSessionIdError);
  });

  it("rejects non-string input", () => {
    expect(() => assertValidSessionId(123 as unknown as string)).toThrow(InvalidSessionIdError);
  });
});
