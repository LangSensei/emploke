import { describe, expect, it } from "vitest";
import { McpInvalidJsonError } from "../../src/mcp/errors.js";
import * as McpFormat from "../../src/mcp/mcp-format.js";

const LABEL = "test-source";

describe("McpFormat.parse", () => {
  it("returns meta + body for a well-formed file", () => {
    const content = JSON.stringify({
      command: "node",
      args: ["server.js"],
      _meta: { name: "azure/mcp" },
    });
    const { meta, body } = McpFormat.parse(content, LABEL);
    expect(meta).toEqual({ name: "azure/mcp" });
    expect(body.command).toBe("node");
    expect(body._meta).toBeDefined();
  });

  it("preserves non-meta keys verbatim", () => {
    const content = JSON.stringify({
      _meta: {
        name: "x/y",
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

  it("ignores _meta.origin when present (origin lives on the entity, not in the file)", () => {
    // Legacy installs and third-party tooling may bake `_meta.origin`
    // into the file; parse must accept it without error and must NOT
    // surface it on the typed meta view (callers should treat origin
    // as an install-time fact, not a declared field).
    const content = JSON.stringify({ _meta: { name: "x/y", origin: "file:/abs/x" } });
    const { meta, body } = McpFormat.parse(content, LABEL);
    expect(meta).toEqual({ name: "x/y" });
    // Body still carries the raw _meta block verbatim.
    expect((body._meta as Record<string, unknown>).origin).toBe("file:/abs/x");
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
    expect(() => McpFormat.parse(JSON.stringify({ _meta: {} }), LABEL)).toThrow(
      McpInvalidJsonError,
    );
    expect(() => McpFormat.parse(JSON.stringify({ _meta: { name: "" } }), LABEL)).toThrow(
      McpInvalidJsonError,
    );
  });

  it("accepts _meta with only name (origin is not required)", () => {
    const { meta } = McpFormat.parse(JSON.stringify({ _meta: { name: "x/y" } }), LABEL);
    expect(meta).toEqual({ name: "x/y" });
  });

  it("includes the source label in error messages", () => {
    try {
      McpFormat.parse("{garbage", "mcps:foo/bar");
    } catch (e) {
      expect(e instanceof Error ? e.message : String(e)).toContain("mcps:foo/bar");
      return;
    }
    throw new Error("expected throw");
  });
});

describe("McpFormat.writeMeta", () => {
  it("creates a fresh _meta block when input is empty", () => {
    const out = McpFormat.writeMeta("", { name: "x/y" }, LABEL);
    const parsed = JSON.parse(out);
    expect(parsed._meta).toEqual({ name: "x/y" });
  });

  it("creates a fresh _meta block when input is whitespace", () => {
    const out = McpFormat.writeMeta("   \n\t  ", { name: "x/y" }, LABEL);
    expect(JSON.parse(out)._meta).toEqual({ name: "x/y" });
  });

  it("adds _meta to a JSON object that lacks one", () => {
    const out = McpFormat.writeMeta(JSON.stringify({ command: "node" }), { name: "x/y" }, LABEL);
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe("node");
    expect(parsed._meta).toEqual({ name: "x/y" });
  });

  it("merges _meta, overwriting name and preserving foreign keys (including legacy origin)", () => {
    const original = JSON.stringify({
      command: "node",
      _meta: {
        name: "old/name",
        origin: "file:/abs/old",
        "io.modelcontextprotocol.registry/extra": { tag: "v1" },
      },
    });
    const out = McpFormat.writeMeta(original, { name: "new/name" }, LABEL);
    const parsed = JSON.parse(out);
    expect(parsed._meta.name).toBe("new/name");
    // Origin is foreign data — writeMeta no longer manages it, so a
    // pre-existing value survives untouched. New installs (with empty
    // input or no _meta.origin) won't introduce it at all.
    expect(parsed._meta.origin).toBe("file:/abs/old");
    expect(parsed._meta["io.modelcontextprotocol.registry/extra"]).toEqual({ tag: "v1" });
    expect(parsed.command).toBe("node");
  });

  it("does not introduce _meta.origin when input lacks it", () => {
    const out = McpFormat.writeMeta(JSON.stringify({ command: "node" }), { name: "x/y" }, LABEL);
    const parsed = JSON.parse(out);
    expect("origin" in parsed._meta).toBe(false);
  });

  it("throws on invalid JSON input", () => {
    expect(() => McpFormat.writeMeta("{not json", { name: "x/y" }, LABEL)).toThrow(
      McpInvalidJsonError,
    );
  });

  it("throws on non-object input", () => {
    expect(() => McpFormat.writeMeta("[1,2]", { name: "x/y" }, LABEL)).toThrow(McpInvalidJsonError);
  });

  it("ends output with a newline", () => {
    const out = McpFormat.writeMeta("", { name: "x/y" }, LABEL);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("output is parseable by parse()", () => {
    const out = McpFormat.writeMeta(JSON.stringify({ command: "node" }), { name: "x/y" }, LABEL);
    const { meta, body } = McpFormat.parse(out, LABEL);
    expect(meta).toEqual({ name: "x/y" });
    expect(body.command).toBe("node");
  });
});

describe("McpFormat.stripMeta", () => {
  it("removes the _meta key", () => {
    const stripped = McpFormat.stripMeta(
      JSON.stringify({ command: "node", _meta: { name: "x/y" } }),
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
