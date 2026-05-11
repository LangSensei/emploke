import { describe, expect, it } from "vitest";
import { McpInvalidJsonError, McpNameInvalidError } from "../../src/mcp/errors.js";
import { Mcp } from "../../src/mcp/mcp-entity.js";
import * as McpFormat from "../../src/mcp/mcp-format.js";

describe("Mcp.create", () => {
  it("validates name and origin, returns an entity with parseable content", () => {
    const m = Mcp.create("azure/mcp", "file:/abs/azure", '{"command":"node"}');
    expect(m.name).toBe("azure/mcp");
    expect(m.origin).toBe("file:/abs/azure");
    // Content is the merged form (with _meta injected)
    const { meta, body } = McpFormat.parse(m.content, "test");
    expect(meta).toEqual({ name: "azure/mcp", origin: "file:/abs/azure" });
    expect(body.command).toBe("node");
  });

  it("injects _meta when input lacks one", () => {
    const m = Mcp.create("x/y", "file:/abs/x", '{"command":"node"}');
    const parsed = JSON.parse(m.content);
    expect(parsed._meta).toEqual({ name: "x/y", origin: "file:/abs/x" });
    expect(parsed.command).toBe("node");
  });

  it("overwrites _meta.{name,origin} when input has stale ones", () => {
    const input = JSON.stringify({
      command: "node",
      _meta: { name: "old/name", origin: "file:/abs/old" },
    });
    const m = Mcp.create("new/name", "file:/abs/new", input);
    const parsed = JSON.parse(m.content);
    expect(parsed._meta).toEqual({ name: "new/name", origin: "file:/abs/new" });
  });

  it("preserves foreign _meta.* keys", () => {
    const input = JSON.stringify({
      _meta: {
        name: "x/y",
        origin: "file:/abs/x",
        "io.modelcontextprotocol.registry/extra": { tag: "v1" },
      },
    });
    const m = Mcp.create("x/y", "file:/abs/x", input);
    const parsed = JSON.parse(m.content);
    expect(parsed._meta["io.modelcontextprotocol.registry/extra"]).toEqual({ tag: "v1" });
  });

  it("rejects invalid name", () => {
    expect(() => Mcp.create("no-slash", "file:/abs/x", "{}")).toThrow(McpNameInvalidError);
    expect(() => Mcp.create("two/slashes/here", "file:/abs/x", "{}")).toThrow(McpNameInvalidError);
    expect(() => Mcp.create("", "file:/abs/x", "{}")).toThrow(McpNameInvalidError);
  });

  it("rejects empty origin", () => {
    expect(() => Mcp.create("x/y", "", "{}")).toThrow(TypeError);
    expect(() => Mcp.create("x/y", null as unknown as string, "{}")).toThrow(TypeError);
  });

  it("rejects unparseable content", () => {
    expect(() => Mcp.create("x/y", "file:/abs/x", "{not json")).toThrow(McpInvalidJsonError);
  });

  it("rejects non-object top-level content", () => {
    expect(() => Mcp.create("x/y", "file:/abs/x", "[1,2,3]")).toThrow(McpInvalidJsonError);
    expect(() => Mcp.create("x/y", "file:/abs/x", '"a string"')).toThrow(McpInvalidJsonError);
  });

  it("accepts empty content (creates fresh _meta-only object)", () => {
    const m = Mcp.create("x/y", "file:/abs/x", "");
    const parsed = JSON.parse(m.content);
    expect(parsed._meta).toEqual({ name: "x/y", origin: "file:/abs/x" });
    expect(Object.keys(parsed)).toEqual(["_meta"]);
  });
});

describe("Mcp.fromStored", () => {
  it("trusts persisted content (no parse, no inject)", () => {
    const stored = '{"raw":"stored","_meta":{"name":"x/y","origin":"file:/abs/x"}}\n';
    const m = Mcp.fromStored("x/y", "file:/abs/x", stored);
    expect(m.content).toBe(stored); // byte-exact, no re-stringify
  });

  it("still validates the name (defensive — repos can't smuggle bad names)", () => {
    expect(() => Mcp.fromStored("no-slash", "file:/abs/x", "{}")).toThrow(McpNameInvalidError);
  });

  it("does NOT validate content (caller is repo, content is trusted)", () => {
    // Even garbage content passes — entity invariant assumed by repo
    const m = Mcp.fromStored("x/y", "file:/abs/x", "garbage not json");
    expect(m.content).toBe("garbage not json");
  });
});

describe("Mcp.withContent", () => {
  it("returns a new entity with replaced content", () => {
    const m1 = Mcp.create("x/y", "file:/abs/x", '{"v":1}');
    const m2 = m1.withContent('{"v":2}');
    expect(m1).not.toBe(m2);
    expect(JSON.parse(m1.content).v).toBe(1);
    expect(JSON.parse(m2.content).v).toBe(2);
  });

  it("preserves identity (name and origin unchanged)", () => {
    const m1 = Mcp.create("x/y", "file:/abs/original", '{"v":1}');
    const m2 = m1.withContent('{"v":2}');
    expect(m2.name).toBe(m1.name);
    expect(m2.origin).toBe(m1.origin);
  });

  it("re-injects entity's stable identity into new _meta", () => {
    const m1 = Mcp.create("x/y", "file:/abs/x", "{}");
    // Caller tries to sneak in different identity via _meta in update
    const m2 = m1.withContent(
      JSON.stringify({
        v: 2,
        _meta: { name: "evil/name", origin: "file:/abs/hijack" },
      }),
    );
    const parsed = JSON.parse(m2.content);
    expect(parsed._meta.name).toBe("x/y"); // ignored, entity wins
    expect(parsed._meta.origin).toBe("file:/abs/x"); // ignored, entity wins
    expect(parsed.v).toBe(2); // user data preserved
  });

  it("rejects unparseable replacement content", () => {
    const m = Mcp.create("x/y", "file:/abs/x", "{}");
    expect(() => m.withContent("{not json")).toThrow(McpInvalidJsonError);
  });

  it("preserves foreign _meta keys from the new content", () => {
    const m1 = Mcp.create("x/y", "file:/abs/x", "{}");
    const m2 = m1.withContent(
      JSON.stringify({
        _meta: { "io.modelcontextprotocol.registry/extra": { tag: "v2" } },
      }),
    );
    const parsed = JSON.parse(m2.content);
    expect(parsed._meta["io.modelcontextprotocol.registry/extra"]).toEqual({ tag: "v2" });
    expect(parsed._meta.name).toBe("x/y");
  });
});

describe("Mcp immutability", () => {
  it("getters return stable values across calls", () => {
    const m = Mcp.create("x/y", "file:/abs/x", "{}");
    expect(m.name).toBe(m.name);
    expect(m.origin).toBe(m.origin);
    expect(m.content).toBe(m.content);
  });

  it("name preserved across reverse-DNS namespaces", () => {
    const m = Mcp.create("io.github.user/weather-tool", "file:/abs/x", "{}");
    expect(m.name).toBe("io.github.user/weather-tool");
  });
});
