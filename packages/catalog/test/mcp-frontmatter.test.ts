import { describe, expect, it } from "vitest";
import { InvalidMcpJsonError } from "../src/errors.js";
import { parseMcpFile, stripMcpMeta, writeMcpMeta } from "../src/mcp/mcp-frontmatter.js";

describe("parseMcpFile", () => {
  it("parses a valid MCP file with inline _meta", () => {
    const content = JSON.stringify({
      command: "npx",
      args: ["-y", "@example/mcp"],
      _meta: { name: "example/mcp", origin: "file:/x" },
    });
    const r = parseMcpFile(content, "test");
    expect(r.meta.name).toBe("example/mcp");
    expect(r.meta.origin).toBe("file:/x");
    expect(r.raw.command).toBe("npx");
  });

  it("rejects non-JSON content", () => {
    expect(() => parseMcpFile("not json", "test")).toThrow(InvalidMcpJsonError);
  });

  it("rejects when top-level is not an object", () => {
    expect(() => parseMcpFile('["a"]', "test")).toThrow(InvalidMcpJsonError);
    expect(() => parseMcpFile("42", "test")).toThrow(InvalidMcpJsonError);
  });

  it("rejects when _meta is missing", () => {
    expect(() => parseMcpFile('{"command":"x"}', "test")).toThrow(/`_meta`/);
  });

  it("rejects when _meta.name is not a string", () => {
    const content = JSON.stringify({
      command: "x",
      _meta: { name: 123, origin: "file:/x" },
    });
    expect(() => parseMcpFile(content, "test")).toThrow(/_meta.name/);
  });

  it("rejects when _meta.origin is missing", () => {
    const content = JSON.stringify({
      command: "x",
      _meta: { name: "ns/n" },
    });
    expect(() => parseMcpFile(content, "test")).toThrow(/_meta.origin/);
  });
});

describe("writeMcpMeta", () => {
  it("adds _meta to a body without one", () => {
    const out = writeMcpMeta('{"command":"x"}', { name: "ns/n", origin: "file:/x" }, "test");
    const parsed = JSON.parse(out);
    expect(parsed._meta).toEqual({ name: "ns/n", origin: "file:/x" });
    expect(parsed.command).toBe("x");
  });

  it("merge-preserves existing _meta sub-keys", () => {
    const input = JSON.stringify({
      command: "x",
      _meta: {
        "io.modelcontextprotocol.registry/version": "1.0.0",
      },
    });
    const out = writeMcpMeta(input, { name: "ns/n", origin: "file:/x" }, "test");
    const parsed = JSON.parse(out);
    expect(parsed._meta.name).toBe("ns/n");
    expect(parsed._meta.origin).toBe("file:/x");
    expect(parsed._meta["io.modelcontextprotocol.registry/version"]).toBe("1.0.0");
  });

  it("overrides only top-level name+origin in _meta (preserves other top-level keys)", () => {
    const input = JSON.stringify({
      command: "x",
      _meta: { name: "old/name", origin: "file:/old", custom: "kept" },
    });
    const out = writeMcpMeta(input, { name: "new/name", origin: "file:/new" }, "test");
    const parsed = JSON.parse(out);
    expect(parsed._meta.name).toBe("new/name");
    expect(parsed._meta.origin).toBe("file:/new");
    expect(parsed._meta.custom).toBe("kept");
  });

  it("creates a fresh stub when content is empty/whitespace", () => {
    const out = writeMcpMeta("", { name: "ns/n", origin: "file:/x" }, "test");
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ _meta: { name: "ns/n", origin: "file:/x" } });
  });

  it("rejects malformed input", () => {
    expect(() => writeMcpMeta("not json", { name: "ns/n", origin: "file:/x" }, "test")).toThrow(
      InvalidMcpJsonError,
    );
  });

  it("output ends with a newline", () => {
    const out = writeMcpMeta('{"command":"x"}', { name: "ns/n", origin: "file:/x" }, "test");
    expect(out.endsWith("\n")).toBe(true);
  });
});

describe("stripMcpMeta", () => {
  it("strips the entire _meta key", () => {
    const content = JSON.stringify({
      command: "x",
      _meta: { name: "ns/n", origin: "file:/x", custom: "anything" },
    });
    const out = stripMcpMeta(content, "test");
    expect(out).toEqual({ command: "x" });
  });

  it("returns the body unchanged when no _meta present", () => {
    const out = stripMcpMeta('{"command":"x"}', "test");
    expect(out).toEqual({ command: "x" });
  });

  it("rejects non-JSON content", () => {
    expect(() => stripMcpMeta("not json", "test")).toThrow(InvalidMcpJsonError);
  });
});
