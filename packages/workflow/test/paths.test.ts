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
    expect(workflowNodeDir(ws, "20260522-aaaaaaaa", "deadbeef-cafe-4bab-89ab-cafebabe1234")).toBe(
      path.join(
        ws,
        "workflows",
        "20260522-aaaaaaaa",
        "nodes",
        "deadbeef-cafe-4bab-89ab-cafebabe1234",
      ),
    );
  });

  it("workflowDir rejects an id that does not match the workflow id grammar", () => {
    const ws = path.resolve("/tmp/ws");
    // Grammar check fires before `safeJoinUnderRoot`; the error
    // surface is the validator's, not the path-component guard's.
    expect(() => workflowDir(ws, "not-a-valid-id")).toThrow(/Invalid workflow id/);
  });

  it("workflowNodeDir rejects '..' as node id", () => {
    const ws = path.resolve("/tmp/ws");
    // Node id grammar (UUIDv4) is checked at function entry, before
    // the lower-level path-component guard would have caught '..'.
    expect(() => workflowNodeDir(ws, "20260522-aaaaaaaa", "..")).toThrow(
      /Invalid workflow node id/,
    );
  });
});
