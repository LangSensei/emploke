import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent-entity.js";
import { SqliteAgentRepository } from "../../src/agent/sqlite-agent-repository.js";

const MIN_VALID = `---
name: researcher
description: Helpful researcher
version: 1.0.0
---
# Body
`;

let repo: SqliteAgentRepository;

beforeEach(() => {
  repo = new SqliteAgentRepository(":memory:");
});

afterEach(() => {
  repo.close();
});

function fixture(
  opts: { name?: string; origin?: string; files?: ReadonlyMap<string, Buffer> } = {},
): { agent: Agent; files: ReadonlyMap<string, Buffer> } {
  const anchor = MIN_VALID.replace("name: researcher", `name: ${opts.name ?? "researcher"}`);
  const agent = Agent.create(anchor, opts.origin ?? "file:/abs/test", "fixture");
  const files = new Map(opts.files ?? new Map());
  files.set("AGENTS.md", Buffer.from(agent.anchorContent, "utf8"));
  return { agent, files };
}

describe("SqliteAgentRepository", () => {
  it("round-trips entity metadata", async () => {
    const { agent, files } = fixture();
    await repo.add(agent, files);
    const got = await repo.findByFqn(agent.fqn);
    expect(got).not.toBeNull();
    expect(got!.fqn).toBe(agent.fqn);
    expect(got!.version).toBe("1.0.0");
  });

  it("rejects add() without AGENTS.md in files", async () => {
    const { agent } = fixture();
    const filesWithoutAnchor = new Map([["other.md", Buffer.from("x")]]);
    await expect(repo.add(agent, filesWithoutAnchor)).rejects.toThrow(/AGENTS\.md/);
  });

  it("upserts atomically (replaces all sibling files)", async () => {
    const { agent } = fixture();
    const v1Files = new Map([
      ["AGENTS.md", Buffer.from(agent.anchorContent, "utf8")],
      ["v1-only.txt", Buffer.from("v1")],
    ]);
    await repo.add(agent, v1Files);

    const v2Files = new Map([
      ["AGENTS.md", Buffer.from(agent.anchorContent, "utf8")],
      ["v2-only.txt", Buffer.from("v2")],
    ]);
    await repo.add(agent, v2Files);

    const out = await collectFiles(repo, agent.fqn);
    expect(out.has("v1-only.txt")).toBe(false);
    expect(out.has("v2-only.txt")).toBe(true);
  });

  it("findByOrigin returns entity matching origin", async () => {
    const { agent, files } = fixture({ origin: "github:o/r/tree/main/x" });
    await repo.add(agent, files);
    const got = await repo.findByOrigin("github:o/r/tree/main/x");
    expect(got!.fqn).toBe(agent.fqn);
  });

  it("findByOrigin returns null for unknown origin", async () => {
    expect(await repo.findByOrigin("file:/abs/never")).toBeNull();
  });

  it("findAll returns sorted entities", async () => {
    const a = fixture({ name: "alpha", origin: "file:/abs/a" });
    const b = fixture({ name: "beta", origin: "file:/abs/b" });
    await repo.add(a.agent, a.files);
    await repo.add(b.agent, b.files);
    const all = await repo.findAll();
    expect(all.map((s) => s.fqn)).toEqual(["public/alpha", "public/beta"]);
  });

  it("delete cascades sibling files", async () => {
    const { agent, files } = fixture();
    files.set("scripts/run.sh", Buffer.from("#!/bin/bash"));
    await repo.add(agent, files);
    await repo.delete(agent.fqn);
    expect(await repo.findByFqn(agent.fqn)).toBeNull();
    const remaining = await collectFiles(repo, agent.fqn);
    expect(remaining.size).toBe(0);
  });

  it("streamFiles preserves binary bytes", async () => {
    const { agent, files } = fixture();
    const bin = Buffer.from([0x00, 0xff, 0x80]);
    files.set("blob.bin", bin);
    await repo.add(agent, files);
    const out = await collectFiles(repo, agent.fqn);
    expect(Buffer.compare(out.get("blob.bin")!, bin)).toBe(0);
  });

  it("streamFiles round-trip text content", async () => {
    const { agent, files } = fixture();
    files.set("scripts/run.sh", Buffer.from("#!/bin/bash"));
    await repo.add(agent, files);
    const out = await collectFiles(repo, agent.fqn);
    expect(out.get("scripts/run.sh")?.toString("utf8")).toBe("#!/bin/bash");
  });
});

async function collectFiles(r: SqliteAgentRepository, name: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for await (const f of r.streamFiles(name)) out.set(f.relPath, f.content);
  return out;
}
