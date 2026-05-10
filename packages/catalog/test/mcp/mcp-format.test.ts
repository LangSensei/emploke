import { describe, expect, it } from "vitest";
import { McpInvalidJsonError } from "../../src/mcp/errors.js";
import * as McpFormat from "../../src/mcp/mcp-format.js";

const LABEL = "test-source";

describe("McpFormat.parse", () => {
  it("returns meta + body for a well-formed file", () => {
    const content = JSON.stringify({
      command: "node",
      args: ["server.js"],
      _meta: { name: "azure/mcp", origin: "file:/abs/azure" },
    });
    const { meta, body } = McpFormat.parse(content, LABEL);
    expect(meta).toEqual({ name: "azure/mcp", origin: "file:/abs/azure" });
    expect(body.command).toBe("node");
    expect(body._meta).toBeDefined();
  });

  it("preserves non-meta keys verbatim", () => {
    const content = JSON.stringify({
      _meta: {
        name: "x/y",
        origin: "file:/abs/x",
        "io.modelcontextprotocol.registry/extra": { tag: "v1" },
      },
      env: { TOKEN: "secret" },
    });
    const { body } = McpFormat.parse(content, LABEL);
    expect(
      (body._meta as Record<string, unknown>)["io.modelcontextprotocol.registry/extra"],
    ).toEqual({
      tag: "v1",
    });
    expect(body.env).toEqual({ TOKEN: "secret" });
  });

  it("throws on invalid JSON", () => {
    expect(() => McpFormat.parse("{not json", LABEL)).toThrow(McpInvalidJsonError);
  });

  it("throws on non-object top-level", () => {
    expect(() => McpFormat.parse('"a string"', LABEL)).toThrow(McpInvalidJsonError);
    expect(() => McpFormat.parse("[1,2,3]", LABEL)).toThrow(McpInvalidJsonError);
    expect(() => McpFormat.parse("null", LABEL)).toThrow(McpInvalidJsonError);
  });

  it("throws when _meta is missing", () => {
    expect(() => McpFormat.parse(JSON.stringify({ command: "x" }), LABEL)).toThrow(
      McpInvalidJsonError,
    );
  });

  it("throws when _meta.name is missing or empty", () => {
    expect(() =>
      McpFormat.parse(JSON.stringify({ _meta: { origin: "file:/abs/x" } }), LABEL),
    ).toThrow(McpInvalidJsonError);
    expect(() =>
      McpFormat.parse(JSON.stringify({ _meta: { name: "", origin: "file:/abs/x" } }), LABEL),
    ).toThrow(McpInvalidJsonError);
  });

  it("throws when _meta.origin is missing or empty", () => {
    expect(() => McpFormat.parse(JSON.stringify({ _meta: { name: "x/y" } }), LABEL)).toThrow(
      McpInvalidJsonError,
    );
  });

  it("includes the source label in error messages", () => {
    try {
      McpFormat.parse("{garbage", "mcps:foo/bar");
    } catch (e) {
      expect((e as Error).message).toContain("mcps:foo/bar");
      return;
    }
    throw new Error("expected throw");
  });
});

describe("McpFormat.writeMeta", () => {
  it("creates a fresh _meta block when input is empty", () => {
    const out = McpFormat.writeMeta("", { name: "x/y", origin: "file:/abs/x" }, LABEL);
    const parsed = JSON.parse(out);
    expect(parsed._meta).toEqual({ name: "x/y", origin: "file:/abs/x" });
  });

  it("creates a fresh _meta block when input is whitespace", () => {
    const out = McpFormat.writeMeta("   \n\t  ", { name: "x/y", origin: "file:/abs/x" }, LABEL);
    expect(JSON.parse(out)._meta).toEqual({ name: "x/y", origin: "file:/abs/x" });
  });

  it("adds _meta to a JSON object that lacks one", () => {
    const out = McpFormat.writeMeta(
      JSON.stringify({ command: "node" }),
      { name: "x/y", origin: "file:/abs/x" },
      LABEL,
    );
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe("node");
    expect(parsed._meta).toEqual({ name: "x/y", origin: "file:/abs/x" });
  });

  it("merges _meta, preserving foreign keys", () => {
    const original = JSON.stringify({
      command: "node",
      _meta: {
        name: "old/name",
        origin: "file:/abs/old",
        "io.modelcontextprotocol.registry/extra": { tag: "v1" },
      },
    });
    const out = McpFormat.writeMeta(original, { name: "new/name", origin: "file:/abs/new" }, LABEL);
    const parsed = JSON.parse(out);
    expect(parsed._meta.name).toBe("new/name");
    expect(parsed._meta.origin).toBe("file:/abs/new");
    expect(parsed._meta["io.modelcontextprotocol.registry/extra"]).toEqual({ tag: "v1" });
    expect(parsed.command).toBe("node");
  });

  it("throws on invalid JSON input", () => {
    expect(() =>
      McpFormat.writeMeta("{not json", { name: "x/y", origin: "file:/abs/x" }, LABEL),
    ).toThrow(McpInvalidJsonError);
  });

  it("throws on non-object input", () => {
    expect(() =>
      McpFormat.writeMeta("[1,2]", { name: "x/y", origin: "file:/abs/x" }, LABEL),
    ).toThrow(McpInvalidJsonError);
  });

  it("ends output with a newline", () => {
    const out = McpFormat.writeMeta("", { name: "x/y", origin: "file:/abs/x" }, LABEL);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("output is parseable by parse()", () => {
    const out = McpFormat.writeMeta(
      JSON.stringify({ command: "node" }),
      { name: "x/y", origin: "file:/abs/x" },
      LABEL,
    );
    const { meta, body } = McpFormat.parse(out, LABEL);
    expect(meta).toEqual({ name: "x/y", origin: "file:/abs/x" });
    expect(body.command).toBe("node");
  });
});

describe("McpFormat.stripMeta", () => {
  it("removes the _meta key", () => {
    const stripped = McpFormat.stripMeta(
      JSON.stringify({ command: "node", _meta: { name: "x/y", origin: "file:/abs/x" } }),
      LABEL,
    );
    expect(stripped).toEqual({ command: "node" });
    expect("_meta" in stripped).toBe(false);
  });

  it("returns the object unchanged when _meta is absent", () => {
    const stripped = McpFormat.stripMeta(JSON.stringify({ command: "node" }), LABEL);
    expect(stripped).toEqual({ command: "node" });
  });

  it("throws on invalid JSON", () => {
    expect(() => McpFormat.stripMeta("{garbage", LABEL)).toThrow(McpInvalidJsonError);
  });

  it("throws on non-object input", () => {
    expect(() => McpFormat.stripMeta("42", LABEL)).toThrow(McpInvalidJsonError);
  });
});
