import { describe, expect, it } from "vitest";
import { create } from "../src/create.js";

describe("create", () => {
  it("returns a task in not_started status", () => {
    const t = create({ agent: "a", instructions: "do" });
    expect(t.status).toBe("not_started");
    expect(t.agent).toBe("a");
    expect(t.instructions).toBe("do");
  });

  it("generates a UUIDv4 id when not supplied", () => {
    const a = create({ agent: "x", instructions: "" });
    const b = create({ agent: "x", instructions: "" });
    expect(a.id).not.toBe(b.id);
    // RFC 4122 v4 shape
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("uses supplied id when provided", () => {
    const t = create({ agent: "a", instructions: "", id: "fixed-id" });
    expect(t.id).toBe("fixed-id");
  });

  it("uses supplied createdAt when provided", () => {
    const stamp = "2025-01-01T00:00:00.000Z";
    const t = create({ agent: "a", instructions: "", createdAt: stamp });
    expect(t.createdAt).toBe(stamp);
  });

  it("defaults createdAt to a parseable ISO 8601 UTC string", () => {
    const before = Date.now();
    const t = create({ agent: "a", instructions: "" });
    const after = Date.now();
    expect(typeof t.createdAt).toBe("string");
    expect(t.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const parsed = Date.parse(t.createdAt);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it("defaults metadata to an empty object", () => {
    const t = create({ agent: "a", instructions: "" });
    expect(t.metadata).toEqual({});
  });

  it("copies supplied metadata (does not retain caller's reference)", () => {
    const md = { creator: "alice" };
    const t = create({ agent: "a", instructions: "", metadata: md });
    expect(t.metadata).toEqual({ creator: "alice" });
    expect(t.metadata).not.toBe(md);
  });

  it("leaves startedAt / endedAt / result / failure undefined", () => {
    const t = create({ agent: "a", instructions: "" });
    expect(t.startedAt).toBeUndefined();
    expect(t.endedAt).toBeUndefined();
    expect(t.result).toBeUndefined();
    expect(t.failure).toBeUndefined();
  });
});
