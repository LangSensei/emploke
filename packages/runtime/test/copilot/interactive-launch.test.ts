import { describe, expect, it } from "vitest";
import { buildCopilotLaunchCommand } from "../../src/copilot/interactive-launch.js";

describe("buildCopilotLaunchCommand", () => {
  it("with no runtimeSessionId returns `copilot --yolo`", () => {
    const c = buildCopilotLaunchCommand("/tmp/work-1", null);
    expect(c.cmd).toBe("copilot");
    expect(c.args).toEqual(["--yolo"]);
    expect(c.cwd).toBe("/tmp/work-1");
    expect(c.display).toBe(`cd "/tmp/work-1" && copilot --yolo`);
  });

  it("with runtimeSessionId uses --resume=<id> form plus --yolo", () => {
    const sid = "12345678-1234-1234-1234-1234567890ab";
    const c = buildCopilotLaunchCommand("/tmp/work-1", sid);
    expect(c.cmd).toBe("copilot");
    expect(c.args).toEqual([`--resume=${sid}`, "--yolo"]);
    expect(c.cwd).toBe("/tmp/work-1");
    expect(c.display).toBe(`cd "/tmp/work-1" && copilot --resume=${sid} --yolo`);
  });

  it("never passes the bare `-i` flag (which actually requires a prompt arg)", () => {
    expect(buildCopilotLaunchCommand("/x", null).args).not.toContain("-i");
    expect(
      buildCopilotLaunchCommand("/x", "12345678-1234-1234-1234-1234567890ab").args,
    ).not.toContain("-i");
  });

  it("uses the equals form for --resume (not the space-separated form)", () => {
    const sid = "11111111-2222-3333-4444-555555555555";
    const args = buildCopilotLaunchCommand("/x", sid).args;
    expect(args).toEqual([`--resume=${sid}`, "--yolo"]);
    expect(args).not.toContain("--resume");
  });

  it("always appends --yolo to skip per-action confirmation prompts", () => {
    expect(buildCopilotLaunchCommand("/x", null).args).toContain("--yolo");
    expect(buildCopilotLaunchCommand("/x", "12345678-1234-1234-1234-1234567890ab").args).toContain(
      "--yolo",
    );
  });

  it("escapes embedded quotes in cwd display", () => {
    const c = buildCopilotLaunchCommand(`/tmp/has "quote"`, null);
    expect(c.display).toContain(`"/tmp/has \\"quote\\""`);
  });
});
