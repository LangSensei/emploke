/**
 * Issue #120 acceptance test: `SessionService.list({ agent })` pushes
 * the filter down to the SQLite layer via the new `agent` column —
 * the manager must not invoke `readAgentName` (and therefore must not
 * scan workdir AGENTS.md files) on the happy path.
 *
 * Strategy: `vi.mock` the `./agent-file.js` module so we can observe
 * every call to `readAgentName`. The test seeds rows that do NOT
 * have an AGENTS.md on disk — if the manager fell back to the old
 * FS-scan code path, the mock would record at least one call.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CatalogService } from "@emploke/catalog";
import { type Runtime, RuntimeRegistry } from "@emploke/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readAgentNameCalls: string[] = [];

vi.mock("../src/agent-file.js", () => ({
  AGENT_FILE_NAME: "AGENTS.md",
  readAgentName: async (workdir: string) => {
    readAgentNameCalls.push(workdir);
    return null;
  },
}));

// Imports BELOW vi.mock so the mock is active when the manager module
// resolves the agent-file dependency.
const { SessionService, SessionRepository } = await import("../src/index.js");
const { openTestSessionDb } = await import("../src/testing.js");

let sessionsDir: string;
let scratch: string;
let dbHandle: ReturnType<typeof openTestSessionDb>;

beforeEach(async () => {
  sessionsDir = await mkdtemp(path.join(tmpdir(), "emploke-no-fs-sessions-"));
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-no-fs-scratch-"));
  dbHandle = openTestSessionDb();
  readAgentNameCalls.length = 0;
});
afterEach(async () => {
  try {
    dbHandle.close();
  } catch {
    // already closed
  }
  await rm(sessionsDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

function fakeCatalog(): CatalogService {
  return {
    catalogDir: "/tmp",
    async resolveAgent() {
      return {} as never;
    },
  } as unknown as CatalogService;
}

function stubRuntime(): Runtime {
  return {
    kind: "copilot",
    async provision() {
      return { runtimeSessionId: null };
    },
    async buildInteractiveLaunch(_rsid, workdir) {
      return { cmd: "x", args: [], cwd: workdir, display: "x" };
    },
  } as unknown as Runtime;
}

async function seedSession(id: string, agent: string): Promise<void> {
  const repo = new SessionRepository({ db: dbHandle.db });
  await repo.insert({
    id,
    runtime: "copilot",
    agent,
    createdAt: "2026-05-19T01:00:00.000Z",
    runtimeSessionId: null,
  });
}

function buildManager(): SessionService {
  const reg = new RuntimeRegistry();
  reg.register(stubRuntime());
  return new SessionService({
    catalog: fakeCatalog(),
    runtimeRegistry: reg,
    sessionsDir,
    workspaceDir: scratch,
    db: dbHandle.db,
  });
}

describe("SessionService.list — agent filter pushed down", () => {
  it("does not call readAgentName when listing with the agent filter", async () => {
    await seedSession("20260519-aaaaaaaa", "public/writer");
    await seedSession("20260519-bbbbbbbb", "public/reviewer");

    const m = buildManager();
    const result = await m.list({ agent: "public/writer" });

    expect(result.map((s) => s.id)).toEqual(["20260519-aaaaaaaa"]);
    expect(readAgentNameCalls).toEqual([]);
  });

  it("returns each session's agent from the persisted column without reading AGENTS.md", async () => {
    await seedSession("20260519-cccccccc", "public/writer");
    const m = buildManager();
    const list = await m.list();
    expect(list.map((s) => s.agent)).toEqual(["public/writer"]);
    expect(readAgentNameCalls).toEqual([]);
  });
});
