import { describe, expect, it } from "vitest";
import {
  COPILOT_SESSION_ID_RE,
  generateCopilotSessionId,
  isCopilotSessionId,
} from "../../src/index.js";

describe("isCopilotSessionId", () => {
  it.each([
    "12345678-1234-1234-1234-1234567890ab",
    "ABCDEF12-3456-7890-abcd-ef1234567890",
    "00000000-0000-0000-0000-000000000000",
  ])("accepts %s", (s) => {
    expect(isCopilotSessionId(s)).toBe(true);
  });

  it.each([
    "12345678123412341234123456789012",
    "not-a-uuid",
    "12345678-1234-1234-1234-12345678901",
    "",
    null,
    undefined,
    42,
  ])("rejects %p", (s) => {
    expect(isCopilotSessionId(s)).toBe(false);
  });
});

describe("generateCopilotSessionId", () => {
  it("produces a value matching the canonical regex", () => {
    const id = generateCopilotSessionId();
    expect(id).toMatch(COPILOT_SESSION_ID_RE);
  });

  it("uses the injected rng", () => {
    const id = generateCopilotSessionId(() => "11111111-1111-1111-1111-111111111111");
    expect(id).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("rejects an injected rng that returns a malformed id", () => {
    expect(() => generateCopilotSessionId(() => "garbage")).toThrow(/not a valid copilot/);
  });
});
