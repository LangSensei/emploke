import { describe, expect, it } from "vitest";
import {
  CopilotActivityStreamParser,
  deriveCopilotResult,
  parseCopilotActivity,
} from "../../src/copilot/activity.js";

/**
 * Tests for the cross-runtime ActivityItem shape Copilot's parser
 * emits. Focuses on the new kinds added in the schema enrichment:
 * `tool_call` (begin/end merge), `system` (hooks/skills/etc.),
 * and assistant tokens.
 */

const ts = "2026-05-12T03:54:11.016Z";
function ev(o: Record<string, unknown>): string {
  return `${JSON.stringify({ timestamp: ts, ...o })}\n`;
}

describe("parseCopilotActivity — basic kinds", () => {
  it("emits user + assistant items with text + seq", () => {
    const raw =
      ev({ type: "user.message", id: "u1", parentId: null, data: { content: "hi" } }) +
      ev({
        type: "assistant.message",
        id: "a1",
        parentId: "u1",
        data: { content: "hello back", outputTokens: 19, model: "claude" },
      });
    const items = parseCopilotActivity(raw);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "user", text: "hi", seq: 0 });
    expect(items[1]).toMatchObject({
      kind: "assistant",
      text: "hello back",
      seq: 1,
      parentSeq: 0,
      tokens: { input: 0, output: 19, total: 19 },
      model: "claude",
    });
  });

  it("drops malformed lines + lower-signal events from the timeline", () => {
    const raw =
      ev({ type: "session.start", id: "s0", parentId: null, data: {} }) +
      ev({ type: "assistant.turn_start", id: "ts0", parentId: null, data: {} }) +
      "{not json}\n" +
      ev({ type: "user.message", id: "u1", parentId: null, data: { content: "go" } });
    const items = parseCopilotActivity(raw);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("user");
  });
});

describe("parseCopilotActivity — tool_call merge", () => {
  it("emits tool_call (running) per toolRequests on assistant message", () => {
    const raw = ev({
      type: "assistant.message",
      id: "a1",
      parentId: null,
      data: {
        content: "running tool",
        toolRequests: [{ name: "list", toolCallId: "call-1", arguments: { path: "/" } }],
      },
    });
    const items = parseCopilotActivity(raw);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      kind: "tool_call",
      callId: "call-1",
      name: "list",
      status: "running",
      args: { path: "/" },
      parentSeq: 0,
    });
  });

  it("merges tool.execution_complete into the running tool_call (same seq, success)", () => {
    const raw =
      ev({
        type: "assistant.message",
        id: "a1",
        parentId: null,
        data: {
          content: "",
          toolRequests: [{ name: "list", toolCallId: "call-1" }],
        },
      }) +
      ev({
        type: "tool.execution_complete",
        id: "c1",
        parentId: null,
        data: { toolCallId: "call-1", success: true, result: "ok" },
      });
    const items = parseCopilotActivity(raw);
    // Two items: assistant + one merged tool_call (NOT three)
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      kind: "tool_call",
      callId: "call-1",
      status: "success",
      result: "ok",
    });
  });

  it("emits a terminal tool_call when only execution_complete arrives (no matching start)", () => {
    const raw = ev({
      type: "tool.execution_complete",
      id: "c1",
      parentId: null,
      data: { toolCallId: "orphan", toolName: "rm", success: false, result: "EACCES" },
    });
    const items = parseCopilotActivity(raw);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "tool_call",
      callId: "orphan",
      status: "error",
      result: "EACCES",
    });
  });
});

describe("parseCopilotActivity — system items", () => {
  it.each([
    ["hook.start", "hook"],
    ["hook.end", "hook"],
    ["skill.invoked", "skill"],
    ["subagent.started", "subagent"],
    ["subagent.completed", "subagent"],
    ["system.notification", "notification"],
    ["session.error", "error"],
  ])("maps %s to a system item with subKind=%s", (eventType, subKind) => {
    const raw = ev({
      type: eventType,
      id: "x1",
      parentId: null,
      data: { message: "hi", name: "n" },
    });
    const items = parseCopilotActivity(raw);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "system", subKind });
    if (eventType === "session.error") {
      expect((items[0] as { level: string }).level).toBe("error");
    }
  });
});

describe("parseCopilotActivity — summary item", () => {
  it("translates session.shutdown into a summary item with stats + tokens", () => {
    const raw = ev({
      type: "session.shutdown",
      id: "sh1",
      parentId: null,
      data: {
        codeChanges: { linesAdded: 12, linesRemoved: 3, filesModified: ["a.ts", "b.ts"] },
        totalPremiumRequests: 4,
        currentModel: "claude-opus",
        modelMetrics: {
          "claude-opus": { usage: { inputTokens: 1000, outputTokens: 500 } },
        },
      },
    });
    const items = parseCopilotActivity(raw);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "summary",
      tokens: { input: 1000, output: 500, total: 1500 },
      stats: {
        linesAdded: 12,
        linesRemoved: 3,
        filesModified: ["a.ts", "b.ts"],
        premiumRequests: 4,
        model: "claude-opus",
      },
    });
  });
});

describe("deriveCopilotResult", () => {
  it("returns the last assistant message content (newest-first walk)", () => {
    const raw =
      ev({
        type: "assistant.message",
        id: "a1",
        parentId: null,
        data: { content: "first" },
      }) +
      ev({
        type: "assistant.message",
        id: "a2",
        parentId: null,
        data: { content: "final answer" },
      });
    expect(deriveCopilotResult(raw)).toBe("final answer");
  });

  it("returns null when no assistant.message exists", () => {
    const raw = ev({ type: "user.message", id: "u1", parentId: null, data: { content: "go" } });
    expect(deriveCopilotResult(raw)).toBeNull();
  });
});

describe("CopilotActivityStreamParser — incremental parsing", () => {
  it("yields items one at a time as lines arrive", () => {
    const parser = new CopilotActivityStreamParser();
    const r1 = parser.parseLine(
      JSON.stringify({
        type: "user.message",
        id: "u1",
        parentId: null,
        timestamp: ts,
        data: { content: "hi" },
      }),
    );
    expect(r1.items).toHaveLength(1);
    expect(r1.items[0]).toMatchObject({ kind: "user", seq: 0 });

    const r2 = parser.parseLine(
      JSON.stringify({
        type: "assistant.message",
        id: "a1",
        parentId: "u1",
        timestamp: ts,
        data: { content: "yo", outputTokens: 5 },
      }),
    );
    expect(r2.items).toHaveLength(1);
    expect(r2.items[0]).toMatchObject({ kind: "assistant", seq: 1, parentSeq: 0 });
    expect(parser.nextSeq).toBe(2);
  });

  it("drops empty / malformed lines without bumping seq", () => {
    const parser = new CopilotActivityStreamParser();
    expect(parser.parseLine("").items).toHaveLength(0);
    expect(parser.parseLine("not json").items).toHaveLength(0);
    expect(parser.nextSeq).toBe(0);
  });

  it("merges tool_call begin/end across separate parseLine calls", () => {
    const parser = new CopilotActivityStreamParser();
    parser.parseLine(
      JSON.stringify({
        type: "assistant.message",
        id: "a1",
        parentId: null,
        timestamp: ts,
        data: {
          content: "",
          toolRequests: [{ name: "ls", toolCallId: "c1" }],
        },
      }),
    );
    expect(parser.nextSeq).toBe(2); // assistant + running tool_call

    const r = parser.parseLine(
      JSON.stringify({
        type: "tool.execution_complete",
        id: "x1",
        parentId: null,
        timestamp: ts,
        data: { toolCallId: "c1", success: true, result: "/" },
      }),
    );
    // Same seq emitted again with updated status — caller dedups by seq.
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: "tool_call", seq: 1, status: "success" });
    expect(parser.nextSeq).toBe(2); // Did NOT bump — same item mutated.
  });
});
