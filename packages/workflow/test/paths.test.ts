import path from "node:path";
import { describe, expect, it } from "vitest";
import { safeJoinUnderRoot, workflowDir, workflowNodeDir } from "../src/paths.js";

describe("safeJoinUnderRoot — defense-in-depth input guard", () => {
  const root = path.resolve("/tmp/wfroot");

  it("accepts a normal id and joins under root", () => {
    const out = safeJoinUnderRoot(root, "20260522-aaaaaaaa");
    expect(out).toBe(path.join(root, "20260522-aaaaaaaa"));
  });

  it("rejects empty id", () => {
    expect(() => safeJoinUnderRoot(root, "")).toThrow(/invalid workflow path component/);
  });

  it("rejects '.'", () => {
    expect(() => safeJoinUnderRoot(root, ".")).toThrow(/invalid workflow path component/);
  });

  it("rejects '..'", () => {
    expect(() => safeJoinUnderRoot(root, "..")).toThrow(/invalid workflow path component/);
  });

  it("rejects forward slash", () => {
    expect(() => safeJoinUnderRoot(root, "a/b")).toThrow(/invalid workflow path component/);
  });

  it("rejects backslash", () => {
    expect(() => safeJoinUnderRoot(root, "a\\b")).toThrow(/invalid workflow path component/);
  });

  it("rejects null byte", () => {
    expect(() => safeJoinUnderRoot(root, "a\0b")).toThrow(/invalid workflow path component/);
  });
});

describe("workflowDir / workflowNodeDir", () => {
  it("workflowDir composes <workspace>/workflows/<id>", () => {
    const ws = path.resolve("/tmp/ws");
    expect(workflowDir(ws, "20260522-aaaaaaaa")).toBe(
      path.join(ws, "workflows", "20260522-aaaaaaaa"),
    );
  });

  it("workflowNodeDir composes <workspace>/workflows/<wf>/nodes/<node>", () => {
    const ws = path.resolve("/tmp/ws");
    expect(workflowNodeDir(ws, "20260522-aaaaaaaa", "20260522-bbbbbbbb")).toBe(
      path.join(ws, "workflows", "20260522-aaaaaaaa", "nodes", "20260522-bbbbbbbb"),
    );
  });

  it("workflowNodeDir rejects '..' as node id", () => {
    const ws = path.resolve("/tmp/ws");
    expect(() => workflowNodeDir(ws, "20260522-aaaaaaaa", "..")).toThrow(
      /invalid workflow path component/,
    );
  });
});
