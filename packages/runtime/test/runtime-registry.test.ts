import { describe, expect, it } from "vitest";
import type { LaunchCommand, Runtime } from "../src/index.js";
import { RuntimeRegistry, UnknownRuntimeError } from "../src/index.js";

function fakeRuntime(kind: string): Runtime {
  return {
    kind,
    async provision() {
      return { runtimeSessionId: null };
    },
    async refresh() {
      return null;
    },
    async buildInteractiveLaunch(
      _runtimeSessionId: string | null,
      workdir: string,
    ): Promise<LaunchCommand> {
      return { cmd: "noop", args: [], cwd: workdir, display: "noop" };
    },
    async deleteState() {},
  };
}

describe("RuntimeRegistry", () => {
  it("registers and retrieves a runtime by kind", () => {
    const reg = new RuntimeRegistry();
    const rt = fakeRuntime("copilot");
    reg.register(rt);
    expect(reg.get("copilot")).toBe(rt);
  });

  it("throws UnknownRuntimeError when kind is not registered", () => {
    const reg = new RuntimeRegistry();
    expect(() => reg.get("gemini")).toThrow(UnknownRuntimeError);
  });

  it("throws when registering a duplicate kind", () => {
    const reg = new RuntimeRegistry();
    reg.register(fakeRuntime("copilot"));
    expect(() => reg.register(fakeRuntime("copilot"))).toThrow(/already registered/);
  });

  it("has() reports membership without throwing", () => {
    const reg = new RuntimeRegistry();
    expect(reg.has("copilot")).toBe(false);
    reg.register(fakeRuntime("copilot"));
    expect(reg.has("copilot")).toBe(true);
  });

  it("kinds() returns registration order", () => {
    const reg = new RuntimeRegistry();
    reg.register(fakeRuntime("copilot"));
    reg.register(fakeRuntime("gemini"));
    reg.register(fakeRuntime("claude-code"));
    expect(reg.kinds()).toEqual(["copilot", "gemini", "claude-code"]);
  });
});
