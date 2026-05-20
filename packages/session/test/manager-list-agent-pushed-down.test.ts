/**
 * Issue #120 acceptance test: `SessionManager.list({ agent })` pushes
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
import { DatabaseSync } from "node:sqlite";
import type { CatalogManager } from "@emploke/catalog";
import { type Runtime, RuntimeRegistry } from "@emploke/runtime";
import { runPkgMigrations } from "@emploke/workspace";
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
const { SESSION_MIGRATIONS, Session, SessionManager, SqliteSessionRepository } = await import(
  "../src/index.js"
);

let sessionsDir: string;
let scratch: string;
let db: DatabaseSync;

beforeEach(async () => {
  sessionsDir = await mkdtemp(path.join(tmpdir(), "emploke-no-fs-sessions-"));
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-no-fs-scratch-"));
  db = new DatabaseSync(":memory:");
  await runPkgMigrations(db, [{ pkg: "session", migrations: SESSION_MIGRATIONS }]);
  readAgentNameCalls.length = 0;
});
afterEach(async () => {
  try {
    db.close();
  } catch {
    // already closed
  }
  await rm(sessionsDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

function fakeCatalog(): CatalogManager {
  return {
    catalogDir: "/tmp",
    async resolveAgent() {
      return {} as never;
    },
  } as unknown as CatalogManager;
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
  const repo = new SqliteSessionRepository({ db });
  await repo.save(
    id,
    Session.create({
      runtime: "copilot",
      agent,
      createdAt: "2026-05-19T01:00:00.000Z",
      runtimeSessionId: null,
    }),
  );
}

function buildManager(): SessionManager {
  const reg = new RuntimeRegistry();
  reg.register(stubRuntime());
  return new SessionManager({
    catalog: fakeCatalog(),
    runtimeRegistry: reg,
    sessionsDir,
    workspaceDir: scratch,
    repository: new SqliteSessionRepository({ db }),
  });
}

describe("SessionManager.list — agent filter pushed down", () => {
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
