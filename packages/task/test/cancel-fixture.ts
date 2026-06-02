/**
 * Shared fixture for the cancel + delete-tightening test files.
 *
 * The 10 R-10 + ADR-001 §3.8 test files all need the same harness
 * (in-memory SQLite repo, tmp tasksDir, a runtime stub that lets the
 * test drive exit timing). Rather than copy the harness into each
 * test file, the shared bits live here. File name doesn't end in
 * `.test.ts` so vitest won't run it as a suite.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentContentSource,
  LaunchCommand,
  ResolvedAgent,
  Runtime,
  RuntimeHandle,
} from "@emploke/runtime";
import { RuntimeRegistry } from "@emploke/runtime";
import type { AgentResolverPort } from "../src/index.js";
import { TaskService } from "../src/index.js";
import { TaskRepository } from "../src/task-repository.js";
import { openTestTaskDb } from "../src/testing.js";

/**
 * Records every kill + lets the test drive the exit timing. By
 * default `kill()` does NOT auto-resolve exit, so a test can issue
 * `m.cancel(id)` and observe the manager parking on `live.settled`.
 * Set `autoExitOnKill=true` to mirror real child_process behaviour
 * (kill → exit fires after a microtask).
 */
export interface TestSpawnHandle {
  readonly runtimeSessionId: string;
  killed: boolean;
  killCount: number;
  resolveExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

export class TestRuntime implements Runtime {
  readonly kind = "copilot";
  readonly handles: TestSpawnHandle[] = [];
  autoExitOnKill = false;
  private nextId = 0;

  async provision(): Promise<{ runtimeSessionId: string | null }> {
    return { runtimeSessionId: null };
  }
  async buildInteractiveLaunch(_rsid: string | null, workdir: string): Promise<LaunchCommand> {
    return { cmd: "stub", args: [], cwd: workdir, display: "stub" };
  }

  get launchHeadless(): Runtime["launchHeadless"] {
    return async (_opts) => {
      const id = ++this.nextId;
      let resolveExit!: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
        resolveExit = res;
      });
      const rec: TestSpawnHandle = {
        runtimeSessionId: `sid-${id.toString().padStart(8, "0")}`,
        killed: false,
        killCount: 0,
        resolveExit,
      };
      const handle: RuntimeHandle = {
        runtimeSessionId: rec.runtimeSessionId,
        sessionDir: Promise.resolve("/tmp/session"),
        exit,
        kill: () => {
          rec.killed = true;
          rec.killCount++;
          if (this.autoExitOnKill) {
            queueMicrotask(() => rec.resolveExit({ code: null, signal: "SIGTERM" }));
          }
        },
      };
      this.handles.push(rec);
      return handle;
    };
  }
}

export interface CancelFixture {
  readonly tasksDir: string;
  readonly orm: ReturnType<typeof openTestTaskDb>;
  readonly repo: TaskRepository;
  readonly rt: TestRuntime;
  readonly m: TaskService;
}

export async function setupCancelFixture(
  opts: {
    autoExitOnKill?: boolean;
    logger?: { warn: (m: object | string, s?: string) => void };
  } = {},
): Promise<CancelFixture> {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "emploke-cancel-fx-"));
  const tasksDir = path.join(workspaceDir, "tasks");
  await mkdir(tasksDir, { recursive: true });
  const orm = openTestTaskDb();
  const rt = new TestRuntime();
  if (opts.autoExitOnKill) rt.autoExitOnKill = true;
  const reg = new RuntimeRegistry();
  reg.register(rt);
  const repo = new TaskRepository({ db: orm.db });
  const m = new TaskService({
    agentResolver: fakeAgentResolver(),
    contentSource: fakeContentSource(),
    runtimeRegistry: reg,
    workspaceDir,
    workspaceId: "cancel-fx-ws",
    db: orm.db,
    now: () => new Date("2026-05-18T01:00:00.000Z"),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  return { tasksDir, orm, repo, rt, m };
}

export async function teardownCancelFixture(fx: CancelFixture): Promise<void> {
  try {
    fx.orm.close();
  } catch {
    // already closed
  }
  await rm(fx.tasksDir, { recursive: true, force: true });
}

export function fakeAgentResolver(): AgentResolverPort {
  return {
    async resolveAgent(_name: string): Promise<ResolvedAgent> {
      return {
        agent: { fqn: "demo" },
        skills: [],
        mcps: [],
      };
    },
    async getAgentEntry(_name: string) {
      return { status: "ready" as const };
    },
  };
}

export function fakeContentSource(): AgentContentSource {
  return {
    async resolveAgent(_name: string): Promise<ResolvedAgent> {
      return {
        agent: { fqn: "demo" },
        skills: [],
        mcps: [],
      };
    },
    async *agentEntries(_fqn: string) {
      // no entries — tests using cancel-fixture never call provision
    },
    async *skillEntries(_fqn: string) {
      // no entries
    },
    async getMcpRuntimeConfig(_fqn: string) {
      return {};
    },
  };
}

/**
 * Capture pino-shaped warn calls into an in-memory list. Hand-rolled
 * (rather than pino (was @emploke/logger; pkg folded into consumers)'s captureLogger) so assertions don't
 * race the real pino writable stream.
 */
export function captureLogger(): {
  calls: { msg: string; meta?: object }[];
  logger: { warn: (m: object | string, s?: string) => void };
} {
  const calls: { msg: string; meta?: object }[] = [];
  return {
    calls,
    logger: {
      warn: (meta: object | string, msg?: string) => {
        if (typeof meta === "string") calls.push({ msg: meta });
        else calls.push({ msg: msg ?? "", meta });
      },
    },
  };
}

/** Poll the manager until the task has reached a terminal status. */
export async function awaitTerminal(m: TaskService, id: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const t = await m.get(id);
    if (t !== null && t.status !== "running" && t.status !== "not_started") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`awaitTerminal: task ${id} never reached terminal`);
}
