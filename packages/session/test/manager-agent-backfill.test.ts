/**
 * Issue #120: `SessionManager.backfillAgentColumn()` populates the v2
 * `agent` column for rows the v1→v2 SQL migration left at `''`. Rows
 * whose AGENTS.md is missing / unreadable stay at `''` and surface a
 * structured warn.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CatalogManager } from "@emploke/catalog";
import { type Runtime, RuntimeRegistry } from "@emploke/runtime";
import { runPkgMigrationsSync } from "@emploke/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_MIGRATIONS, SessionManager, SqliteSessionRepository } from "../src/index.js";

let sessionsDir: string;
let scratch: string;
let db: DatabaseSync;
let warnCalls: { msg: string; meta?: object }[];

beforeEach(async () => {
  sessionsDir = await mkdtemp(path.join(tmpdir(), "emploke-backfill-sessions-"));
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-backfill-scratch-"));
  db = new DatabaseSync(":memory:");
  runPkgMigrationsSync(db, [{ pkg: "session", migrations: SESSION_MIGRATIONS }]);
  warnCalls = [];
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

function captureLogger() {
  return {
    info: () => {},
    warn: (meta: object | string, msg?: string) => {
      if (typeof meta === "string") warnCalls.push({ msg: meta });
      else warnCalls.push({ msg: msg ?? "", meta });
    },
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => captureLogger(),
    level: "warn",
  } as unknown as import("@emploke/logger").Logger;
}

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

async function seedV1RowWithEmptyAgent(id: string): Promise<void> {
  // The migration leaves agent='' for legacy rows by default. We
  // mirror that here by writing through the v2 repository with an
  // agent set to '' (validation happens at the entity factory only on
  // fromStored, not on save's INSERT — we go below the entity by
  // direct SQL to skip the non-empty assertion).
  db.prepare(
    "INSERT INTO sessions (id, agent, runtime, created_at, runtime_session_id, last_launch_mode) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, "", "copilot", "2026-05-19T01:00:00.000Z", null, null);
}

async function writeAgentsMd(id: string, body: string): Promise<void> {
  const workdir = path.join(sessionsDir, id);
  await mkdir(workdir, { recursive: true });
  await writeFile(path.join(workdir, "AGENTS.md"), body, "utf8");
}

function buildManager(): SessionManager {
  const reg = new RuntimeRegistry();
  reg.register(stubRuntime());
  return new SessionManager({
    catalog: fakeCatalog(),
    runtimeRegistry: reg,
    sessionsDir,
    workspaceDir: scratch,
    repository: new SqliteSessionRepository({ db, logger: captureLogger() }),
    logger: captureLogger(),
  });
}

describe("SessionManager.backfillAgentColumn", () => {
  it("populates the agent column for v1 rows from <workdir>/AGENTS.md", async () => {
    const id = "20260519-aaaaaaaa";
    await seedV1RowWithEmptyAgent(id);
    await writeAgentsMd(id, "---\nname: writer\nscope: public\n---\n# writer\n");

    const m = buildManager();
    await m.backfillAgentColumn();

    const row = db.prepare("SELECT agent FROM sessions WHERE id = ?").get(id) as { agent: string };
    expect(row.agent).toBe("public/writer");
  });

  it("defaults missing scope to 'public' when the frontmatter omits it", async () => {
    const id = "20260519-bbbbbbbb";
    await seedV1RowWithEmptyAgent(id);
    await writeAgentsMd(id, "---\nname: reviewer\n---\n# reviewer\n");

    const m = buildManager();
    await m.backfillAgentColumn();

    const row = db.prepare("SELECT agent FROM sessions WHERE id = ?").get(id) as { agent: string };
    expect(row.agent).toBe("public/reviewer");
  });

  it("leaves the agent at '' and warns when AGENTS.md is missing", async () => {
    const id = "20260519-cccccccc";
    await seedV1RowWithEmptyAgent(id);
    // No AGENTS.md written.

    const m = buildManager();
    await m.backfillAgentColumn();

    const row = db.prepare("SELECT agent FROM sessions WHERE id = ?").get(id) as { agent: string };
    expect(row.agent).toBe("");
    expect(
      warnCalls.some((c) => c.msg.includes("backfillAgentColumn left row at empty agent")),
    ).toBe(true);
  });

  it("leaves the agent at '' when AGENTS.md has no frontmatter", async () => {
    const id = "20260519-dddddddd";
    await seedV1RowWithEmptyAgent(id);
    await writeAgentsMd(id, "# no frontmatter here\n");

    const m = buildManager();
    await m.backfillAgentColumn();

    const row = db.prepare("SELECT agent FROM sessions WHERE id = ?").get(id) as { agent: string };
    expect(row.agent).toBe("");
  });

  it("is idempotent — a second call is a no-op", async () => {
    const id = "20260519-eeeeeeee";
    await seedV1RowWithEmptyAgent(id);
    await writeAgentsMd(id, "---\nname: writer\nscope: public\n---\n");

    const m = buildManager();
    await m.backfillAgentColumn();
    await m.backfillAgentColumn();

    const row = db.prepare("SELECT agent FROM sessions WHERE id = ?").get(id) as { agent: string };
    expect(row.agent).toBe("public/writer");
  });
});
