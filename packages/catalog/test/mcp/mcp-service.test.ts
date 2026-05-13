import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  McpNameInvalidError,
  McpNotFoundError,
  McpOriginConflictError,
} from "../../src/mcp/errors.js";
import { Mcp } from "../../src/mcp/mcp-entity.js";
import * as McpFormat from "../../src/mcp/mcp-format.js";
import type { McpRepository } from "../../src/mcp/mcp-repository.js";
import { McpService } from "../../src/mcp/mcp-service.js";
import { SqliteMcpRepository } from "../../src/mcp/sqlite-mcp-repository.js";

/**
 * The McpService contract is repository-agnostic. Set up as a backend
 * matrix so future repository implementations can be swapped in by
 * adding a row to `BACKENDS` — no fixture duplication.
 */
type Backend = {
  readonly name: string;
  readonly setup: () => Promise<{ repo: McpRepository; teardown: () => Promise<void> }>;
};

const BACKENDS: Backend[] = [
  {
    name: "SqliteMcpRepository (in-memory)",
    setup: async () => {
      const db = new DatabaseSync(":memory:");
      const repo = new SqliteMcpRepository({ db });
      return {
        repo,
        teardown: async () => {
          db.close();
        },
      };
    },
  },
];

for (const backend of BACKENDS) {
  describe(`McpService over ${backend.name}`, () => {
    let repo: McpRepository;
    let teardown: () => Promise<void>;
    let fetchStub: ReturnType<typeof vi.fn>;
    let svc: McpService;

    beforeEach(async () => {
      const setup = await backend.setup();
      repo = setup.repo;
      teardown = setup.teardown;
      fetchStub = vi.fn();
      svc = new McpService(repo, (origin) => fetchStub(origin));
    });

    afterEach(async () => {
      await teardown();
    });

    describe("install", () => {
      it("persists a new entity", async () => {
        const m = await svc.install("azure/mcp", "file:/abs/azure", '{"command":"node"}');
        expect(m).toBeInstanceOf(Mcp);
        expect(m.name).toBe("azure/mcp");
        expect(m.origin).toBe("file:/abs/azure");
        expect(await svc.has("azure/mcp")).toBe(true);
        expect(await svc.list()).toHaveLength(1);
      });

      it("injects _meta.name into the stored content (origin lives on the entity, not in the file)", async () => {
        await svc.install("azure/mcp", "file:/abs/azure", '{"command":"node","args":["s.js"]}');
        const content = await svc.getContent("azure/mcp");
        const { meta, body } = McpFormat.parse(content, "test");
        expect(meta).toEqual({ name: "azure/mcp" });
        expect(body.command).toBe("node");
      });

      it("preserves foreign _meta keys when input already carries _meta", async () => {
        const input = JSON.stringify({
          command: "node",
          _meta: {
            name: "old/name",
            origin: "file:/abs/old",
            "io.modelcontextprotocol.registry/extra": { tag: "v1" },
          },
        });
        await svc.install("new/name", "file:/abs/new", input);
        const stored = await svc.getContent("new/name");
        const { meta, body } = McpFormat.parse(stored, "test");
        expect(meta).toEqual({ name: "new/name" });
        expect(
          (body._meta as Record<string, unknown>)["io.modelcontextprotocol.registry/extra"],
        ).toEqual({
          tag: "v1",
        });
      });

      it("rejects invalid names", async () => {
        await expect(svc.install("no-slash-name", "file:/abs/x", "{}")).rejects.toThrow(
          McpNameInvalidError,
        );
        await expect(svc.install("two/slashes/here", "file:/abs/x", "{}")).rejects.toThrow(
          McpNameInvalidError,
        );
        await expect(svc.install("/leading", "file:/abs/x", "{}")).rejects.toThrow(
          McpNameInvalidError,
        );
      });

      it("rejects empty origin", async () => {
        await expect(svc.install("x/y", "", "{}")).rejects.toThrow();
      });

      it("allows reinstall under the same origin (upsert)", async () => {
        await svc.install("x/y", "file:/abs/x", '{"v":1}');
        await svc.install("x/y", "file:/abs/x", '{"v":2}');
        const content = await svc.getContent("x/y");
        expect(JSON.parse(content).v).toBe(2);
      });

      it("rejects reinstall with a different origin", async () => {
        await svc.install("x/y", "file:/abs/x", '{"v":1}');
        await expect(svc.install("x/y", "file:/abs/other", '{"v":2}')).rejects.toThrow(
          McpOriginConflictError,
        );
      });

      it("does not corrupt storage on a failed install", async () => {
        await expect(svc.install("x/y", "file:/abs/x", "{not json")).rejects.toThrow();
        expect(await svc.has("x/y")).toBe(false);
        expect(await repo.findByName("x/y")).toBeNull();
      });
    });

    describe("installFromOrigin", () => {
      it("dispatches to the fetcher and installs the returned content", async () => {
        fetchStub.mockResolvedValueOnce('{"command":"node"}');
        const m = await svc.installFromOrigin("azure/mcp", "file:/abs/azure");
        expect(m.origin).toBe("file:/abs/azure");
        expect(await svc.has("azure/mcp")).toBe(true);
        expect(fetchStub).toHaveBeenCalledWith("file:/abs/azure");
      });

      it("propagates fetcher errors as-is", async () => {
        fetchStub.mockRejectedValueOnce(new Error("upstream 404"));
        await expect(svc.installFromOrigin("x/y", "file:/abs/x")).rejects.toThrow(/upstream 404/);
      });
    });

    describe("updateContent", () => {
      it("replaces content while preserving the stored origin", async () => {
        await svc.install("x/y", "file:/abs/x", '{"v":1}');
        const updated = await svc.updateContent("x/y", '{"v":2,"updated":true}');
        expect(updated.origin).toBe("file:/abs/x");
        const { meta, body } = McpFormat.parse(updated.content, "test");
        expect(meta.name).toBe("x/y");
        expect(body.v).toBe(2);
        expect(body.updated).toBe(true);
      });

      it("ignores any _meta in update payload (entity wins for name; origin is read from row)", async () => {
        await svc.install("x/y", "file:/abs/x", "{}");
        const updated = await svc.updateContent(
          "x/y",
          JSON.stringify({ v: 2, _meta: { name: "evil/name", origin: "file:/abs/hijack" } }),
        );
        const { meta } = McpFormat.parse(updated.content, "test");
        expect(meta.name).toBe("x/y");
        // Origin lives on the entity / SQLite row, never the file.
        expect(updated.origin).toBe("file:/abs/x");
      });

      it("throws NotFound when updating a missing entry", async () => {
        await expect(svc.updateContent("missing/x", "{}")).rejects.toThrow(McpNotFoundError);
      });

      it("rejects writes on immutable (non-file:) origins", async () => {
        await svc.install(
          "vendor/upstream",
          "github:o/r/tree/main/mcps/upstream.json",
          '{"command":"node"}',
        );
        await expect(
          svc.updateContent("vendor/upstream", '{"command":"hacked"}'),
        ).rejects.toMatchObject({
          name: "ImmutableOriginError",
          fqn: "vendor/upstream",
          origin: "github:o/r/tree/main/mcps/upstream.json",
        });
      });
    });

    describe("delete", () => {
      it("removes from storage", async () => {
        await svc.install("x/y", "file:/abs/x", "{}");
        await svc.delete("x/y");
        expect(await svc.has("x/y")).toBe(false);
        expect(await repo.findByName("x/y")).toBeNull();
      });

      it("throws NotFound when deleting a missing entry", async () => {
        await expect(svc.delete("never/existed")).rejects.toThrow(McpNotFoundError);
      });

      it("allows reinstall after delete (no zombie)", async () => {
        await svc.install("x/y", "file:/abs/first", '{"v":1}');
        await svc.delete("x/y");
        await svc.install("x/y", "file:/abs/second", '{"v":2}');
        const m = await svc.get("x/y");
        expect(m!.origin).toBe("file:/abs/second");
        expect(JSON.parse(m!.content).v).toBe(2);
      });
    });

    describe("get / list", () => {
      it("returns null for absent entry", async () => {
        expect(await svc.get("missing/x")).toBeNull();
      });

      it("get returns a Mcp entity", async () => {
        await svc.install("x/y", "file:/abs/x", "{}");
        const m = await svc.get("x/y");
        expect(m).toBeInstanceOf(Mcp);
        expect(m!.name).toBe("x/y");
      });

      it("list reflects install / delete in real time", async () => {
        expect(await svc.list()).toHaveLength(0);
        await svc.install("a/x", "file:/abs/a", "{}");
        await svc.install("b/y", "file:/abs/b", "{}");
        expect(await svc.list()).toHaveLength(2);
        await svc.delete("a/x");
        expect(await svc.list()).toHaveLength(1);
      });
    });
  });
}
