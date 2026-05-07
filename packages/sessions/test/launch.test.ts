import { describe, expect, it } from "vitest";
import { buildLaunchCommand, buildResumeCommand, isCopilotSessionId } from "../src/launch.js";

describe("launch commands", () => {
  it("builds launch command", () => {
    const c = buildLaunchCommand("/tmp/session-1");
    expect(c.cmd).toBe("copilot");
    expect(c.args).toEqual(["-i"]);
    expect(c.cwd).toBe("/tmp/session-1");
    expect(c.display).toBe(`cd "/tmp/session-1" && copilot -i`);
  });

  it("builds resume command", () => {
    const sid = "12345678-1234-1234-1234-1234567890ab";
    const c = buildResumeCommand("/tmp/session-1", sid);
    expect(c.args).toEqual(["-i", "--resume", sid]);
    expect(c.display).toBe(`cd "/tmp/session-1" && copilot -i --resume ${sid}`);
  });

  it("escapes embedded quotes in cwd display", () => {
    const c = buildLaunchCommand(`/tmp/has "quote"`);
    expect(c.display).toContain(`"/tmp/has \\"quote\\""`);
  });
});

describe("isCopilotSessionId", () => {
  it.each([
    "12345678-1234-1234-1234-1234567890ab",
    "ABCDEF12-3456-7890-abcd-ef1234567890",
  ])("accepts %s", (s) => {
    expect(isCopilotSessionId(s)).toBe(true);
  });

  it.each([
    "12345678123412341234123456789012", // no dashes
    "not-a-uuid",
    "12345678-1234-1234-1234-12345678901", // 11 chars in last group
    "",
  ])("rejects %s", (s) => {
    expect(isCopilotSessionId(s)).toBe(false);
  });
});
