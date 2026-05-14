import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";
import type { LaunchCommand, Runtime, RuntimeHandle } from "@emploke/runtime";
import { RuntimeRegistry } from "@emploke/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentNotFoundError,
  CorruptedTaskError,
  type DispatchOpts,
  EntryNotReadyError,
  InvalidTaskIdError,
  RuntimeDoesNotSupportTasksError,
  readTaskRuntimeMetadata,
  SqliteTaskRepository,
  Task,
  TaskManager,
  TaskNotFoundError,
} from "../src/index.js";

// ───── filesystem fixture lifecycle ────────────────────────

let tasksDir: string;
const openDbs: DatabaseSync[] = [];

function makeRepo(): SqliteTaskRepository {
  const db = new DatabaseSync(":memory:");
  openDbs.push(db);
  return new SqliteTaskRepository({ db });
}

beforeEach(async () => {
  tasksDir = await mkdtemp(path.join(tmpdir(), "emploke-tasks-root-"));
});
afterEach(async () => {
  for (const d of openDbs.splice(0)) {
    try {
      d.close();
    } catch {
      // already closed
    }
  }
  await rm(tasksDir, { recursive: true, force: true });
});

// ───── catalog stub ─────────────────────────────────────────

interface StubCatalogOpts {
  agents?: Record<string, AgentResolveResult>;
  resolveError?: Error;
  /**
   * Map of agent name → blockedReason. When `getAgentEntry` is called
   * for one of these names it returns `status: "blocked"` so dispatch
   * surfaces `EntryNotReadyError`. Used to test the status guard added
   * in the issue #57 rework.
   */
  blockedAgents?: Record<string, import("@emploke/catalog").BlockedReason>;
}

function stubCatalog(opts: StubCatalogOpts = {}): CatalogManager {
  const agents = opts.agents ?? {};
  const blocked = opts.blockedAgents ?? {};
  return {
    catalogDir: "/tmp/catalog",
    async resolveAgent(name: string): Promise<AgentResolveResult> {
      if (opts.resolveError) throw opts.resolveError;
      const a = agents[name];
      if (!a) throw new Error(`agent not found in catalog: "${name}"`);
      return a;
    },
    // Status guard added in PR #57: dispatch refuses blocked agents.
    // Stub returns a `ready` entry for known agents and `null` for
    // unknown ones (which dispatch translates to AgentNotFoundError).
    async getAgentEntry(name: string) {
      if (opts.resolveError) throw opts.resolveError;
      if (!(name in agents)) return null;
      const reason = blocked[name];
      if (reason !== undefined) {
        return {
          agent: { fqn: name } as unknown,
          status: "blocked" as const,
          blockedReason: reason,
        } as unknown as ReturnType<CatalogManager["getAgentEntry"]> extends Promise<infer T>
          ? T
          : never;
      }
      return { agent: { fqn: name } as unknown, status: "ready" as const } as unknown as ReturnType<
        CatalogManager["getAgentEntry"]
      > extends Promise<infer T>
        ? T
        : never;
    },
  } as unknown as CatalogManager;
}

const fakeAgentResolve = (name: string): AgentResolveResult =>
  ({
    agent: { name, description: "x", version: "0.0.1" },
    agentPath: `/tmp/catalog/agents/${name}`,
    skills: [],
    mcps: [],
  }) as unknown as AgentResolveResult;

// ───── runtime stub ─────────────────────────────────────────

interface SpawnedHandle {
  readonly id: number;
  readonly pid: number;
  readonly runtimeSessionId: string | undefined;
  resolveSessionDir: (dir: string) => void;
  rejectSessionDir: (err: Error) => void;
  /** Resolves the exit promise; the manager will then write the terminal status. */
  exit: (info: { code: number | null; signal: NodeJS.Signals | null }) => Promise<void>;
  killed: boolean;
  killCount: number;
  /** When true, kill() auto-resolves exit (mirrors child_process behavior). */
  autoExitOnKill: boolean;
  /** Resolves once the manager finishes its post-exit persistence. */
  persisted: Promise<void>;
}

class StubRuntime implements Runtime {
  readonly kind: string;

  /** If set, dispatch throws this BEFORE creating a handle. */
  dispatchError: Error | null = null;
  /** Per-call session id override. Default: a unique uuid-ish per spawn. */
  nextRuntimeSessionId: string | undefined = undefined;
  /** Per-call sessionDir override. Default: pre-resolved to a stable dir. */
  nextSessionDir: { mode: "resolve" | "pending" | "reject"; value?: string; err?: Error } = {
    mode: "resolve",
    value: "/tmp/session-default",
  };
  /** True when dispatch is implemented; flip false to test "doesn't support tasks". */
  dispatchSupported = true;

  /** Auto-fire exit on kill, mirroring real child_process behavior. */
  autoExitOnKill = false;

  /** Per-call deleteState records keyed by runtimeSessionId. */
  readonly deleteStateCalls: { runtimeSessionId: string }[] = [];
  /** If set, deleteState throws this — to test runtime-failure aborts. */
  deleteStateError: Error | null = null;

  private nextId = 1;
  readonly handles: SpawnedHandle[] = [];
  readonly dispatchCalls: {
    taskDir: string;
    agent: AgentResolveResult;
    prompt: string;
    workspaceDir?: string;
    subprocessEnv?: NodeJS.ProcessEnv;
  }[] = [];

  constructor(kind = "copilot") {
    this.kind = kind;
  }

  async provision(): Promise<{ runtimeSessionId: string | null }> {
    return { runtimeSessionId: null };
  }
  async buildInteractiveLaunch(_rsid: string | null, workdir: string): Promise<LaunchCommand> {
    return { cmd: "stub", args: [], cwd: workdir, display: "stub" };
  }

  /** Records every call to deleteState so tests can assert on cleanup. */
  async deleteState(runtimeSessionId: string): Promise<void> {
    this.deleteStateCalls.push({ runtimeSessionId });
    if (this.deleteStateError !== null) {
      const e = this.deleteStateError;
      this.deleteStateError = null;
      throw e;
    }
  }

  // launchHeadless is set conditionally via Object.defineProperty so we can
  // model "runtime doesn't implement it" cleanly.
  get launchHeadless(): Runtime["launchHeadless"] | undefined {
    if (!this.dispatchSupported) return undefined;
    return async (opts) => this.spawnHandle(opts);
  }

  private async spawnHandle(opts: {
    taskDir: string;
    agent: AgentResolveResult;
    prompt: string;
    workspaceDir?: string;
    subprocessEnv?: NodeJS.ProcessEnv;
  }): Promise<RuntimeHandle> {
    if (this.dispatchError) {
      const e = this.dispatchError;
      this.dispatchError = null;
      throw e;
    }
    this.dispatchCalls.push(opts);

    const id = this.nextId++;
    const pid = 10000 + id;
    const runtimeSessionId =
      this.nextRuntimeSessionId !== undefined
        ? this.nextRuntimeSessionId
        : `runtime-sid-${id.toString().padStart(8, "0")}`;
    this.nextRuntimeSessionId = undefined;

    let resolveSessionDir!: (v: string) => void;
    let rejectSessionDir!: (e: Error) => void;
    const sessionDirP = new Promise<string>((res, rej) => {
      resolveSessionDir = res;
      rejectSessionDir = rej;
    });

    const dirPolicy = this.nextSessionDir;
    this.nextSessionDir = { mode: "resolve", value: "/tmp/session-default" };
    if (dirPolicy.mode === "resolve") {
      // queue microtask so the manager has a chance to wire its `.then()`
      queueMicrotask(() => resolveSessionDir(dirPolicy.value ?? "/tmp/session-default"));
    } else if (dirPolicy.mode === "reject") {
      queueMicrotask(() => rejectSessionDir(dirPolicy.err ?? new Error("session dir failure")));
    }

    let resolveExit!: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const exitP = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
      resolveExit = res;
    });

    let resolvePersisted!: () => void;
    const persistedP = new Promise<void>((res) => {
      resolvePersisted = res;
    });

    const handle: RuntimeHandle = {
      pid,
      runtimeSessionId,
      sessionDir: sessionDirP,
      exit: exitP,
      kill: () => {
        rec.killed = true;
        rec.killCount++;
        if (rec.autoExitOnKill) {
          // Real child_process fires 'exit' after kill in a microtask;
          // mimic that here so tests don't have to rig their own trigger.
          queueMicrotask(() => {
            resolveExit({ code: null, signal: "SIGTERM" });
          });
        }
      },
    };

    const rec: SpawnedHandle = {
      id,
      pid,
      runtimeSessionId,
      resolveSessionDir,
      rejectSessionDir,
      killed: false,
      killCount: 0,
      autoExitOnKill: this.autoExitOnKill,
      exit: async (info) => {
        resolveExit(info);
        // Yield enough times that the manager's exit handler can persist
        // the terminal status. The handler does:
        //   `await handle.exit` → `await applyTerminal()` → `await persist`.
        // 8 microtask flushes covers that path even with macrotask hops.
        await flushMicrotasks(8);
        resolvePersisted();
      },
      persisted: persistedP,
    };
    this.handles.push(rec);
    return handle;
  }
}

function makeRegistry(rt: Runtime): RuntimeRegistry {
  const reg = new RuntimeRegistry();
  reg.register(rt);
  return reg;
}

// ───── deterministic clock + id source ─────────────────────

const fixedNow = (iso: string) => () => new Date(iso);

/**
 * Sequential 4-byte random source. Each call returns a deterministic
 * suffix so test ids are stable + unique per attempt. Caller controls
 * starting value to avoid collisions across tests.
 */
const seqRandom = (start = 1) => {
  let i = start - 1;
  return (n: number) => {
    i++;
    return Buffer.alloc(n, i);
  };
};

// ───── helpers ──────────────────────────────────────────────

const recorder = () => {
  // Matches pino's API shape: (meta, msg). Hand-rolled rather than
  // pulled from `@emploke/logger/testing.captureLogger` because these
  // tests want a synchronous in-memory record (captureLogger goes
  // through a real pino instance + Writable stream which can race
  // assertion timing in tight loops).
  const calls: { msg: string; meta?: object }[] = [];
  return {
    logger: {
      warn: (meta: object | string, msg?: string) => {
        if (typeof meta === "string") calls.push({ msg: meta });
        else calls.push({ msg: msg ?? "", meta });
      },
    },
    calls,
  };
};

const flushMicrotasks = async (n = 1) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

const dispatchOf = (overrides: Partial<DispatchOpts> = {}): DispatchOpts => ({
  agent: "demo",
  instructions: "Do the thing.",
  ...overrides,
});

const makeManager = (
  overrides: {
    catalog?: CatalogManager;
    runtime?: Runtime;
    registry?: RuntimeRegistry;
    now?: () => Date;
    randomBytes?: (n: number) => Buffer;
    logger?: { warn: (meta: object | string, msg?: string) => void };
    repository?: SqliteTaskRepository;
    workspaceId?: string;
    subprocessEnv?: NodeJS.ProcessEnv;
  } = {},
): { m: TaskManager; repo: SqliteTaskRepository } => {
  const rt = overrides.runtime ?? new StubRuntime();
  const registry = overrides.registry ?? makeRegistry(rt);
  const repo = overrides.repository ?? makeRepo();
  const m = new TaskManager({
    catalog: overrides.catalog ?? stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
    runtimeRegistry: registry,
    tasksDir,
    workspaceDir: tasksDir,
    now: overrides.now ?? fixedNow("2026-05-08T01:05:00.000Z"),
    randomBytes: overrides.randomBytes ?? seqRandom(),
    logger: overrides.logger,
    repository: repo,
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {}),
    ...(overrides.subprocessEnv !== undefined ? { subprocessEnv: overrides.subprocessEnv } : {}),
  });
  return { m, repo };
};

// ═════ tests ════════════════════════════════════════════════

describe("dispatch — happy path", () => {
  it("creates dir, persists running task to repository, populates runtime metadata, returns Task", async () => {
    const rt = new StubRuntime();
    const { m, repo } = makeManager({ runtime: rt });

    const t = await m.dispatch(dispatchOf({ agent: "demo", instructions: "Plant a tree." }));

    expect(t.agent).toBe("demo");
    expect(t.instructions).toBe("Plant a tree.");
    expect(t.status).toBe("running");
    expect(t.startedAt).toBe("2026-05-08T01:05:00.000Z");
    expect(t.id).toMatch(/^\d{8}-[0-9a-f]{8}$/);

    expect(rt.dispatchCalls).toHaveLength(1);
    expect(rt.dispatchCalls[0].prompt).toBe("Plant a tree.");

    const meta = readTaskRuntimeMetadata(t);
    expect(meta.workdir).toBe(path.join(tasksDir, t.id));
    expect(meta.runtime).toBe("copilot");
    expect(meta.pid).toBe(rt.handles[0].pid);
    expect(meta.runtimeSessionId).toBe(rt.handles[0].runtimeSessionId);

    // The task row in the repository matches the returned in-memory
    // task. (Replaces the old per-workdir `task.json` round-trip.)
    const persisted = await repo.read(t.id);
    expect(persisted?.status).toBe("running");
    expect(persisted?.id).toBe(t.id);
  });
});

describe("dispatch — error paths", () => {
  it("AgentNotFoundError when catalog cannot resolve the agent", async () => {
    const { m } = makeManager({
      catalog: stubCatalog({ resolveError: new Error("nope") }),
    });
    await expect(m.dispatch(dispatchOf())).rejects.toBeInstanceOf(AgentNotFoundError);
    // No directory should have been created.
    const entries = await safeReaddir(tasksDir);
    expect(entries).toEqual([]);
  });

  it("AgentNotFoundError when caller passes empty/invalid agent name", async () => {
    const { m } = makeManager();
    await expect(m.dispatch(dispatchOf({ agent: "" }))).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it("RuntimeDoesNotSupportTasksError when chosen runtime omits dispatch", async () => {
    const rt = new StubRuntime();
    rt.dispatchSupported = false;
    const { m } = makeManager({ runtime: rt });
    await expect(m.dispatch(dispatchOf())).rejects.toBeInstanceOf(RuntimeDoesNotSupportTasksError);
    const entries = await safeReaddir(tasksDir);
    expect(entries).toEqual([]);
  });

  it("rolls back the workdir when the runtime throws during dispatch", async () => {
    const rt = new StubRuntime();
    rt.dispatchError = new Error("boom in spawn");
    const { m } = makeManager({ runtime: rt });

    await expect(m.dispatch(dispatchOf())).rejects.toThrow(/boom in spawn/);
    const entries = await safeReaddir(tasksDir);
    expect(entries).toEqual([]);
  });

  it("EntryNotReadyError when the agent is blocked due to prereqs", async () => {
    const { m } = makeManager({
      catalog: stubCatalog({
        agents: { demo: fakeAgentResolve("demo") },
        blockedAgents: { demo: { needsPrereqsAck: true } },
      }),
    });
    const err = await m.dispatch(dispatchOf({ agent: "demo" })).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(EntryNotReadyError);
    expect((err as EntryNotReadyError).agent).toBe("demo");
    expect((err as EntryNotReadyError).reason?.needsPrereqsAck).toBe(true);
    // No dir created — guard fires before workdir reservation.
    const entries = await safeReaddir(tasksDir);
    expect(entries).toEqual([]);
  });

  it("EntryNotReadyError when the agent is blocked because it was disabled by user", async () => {
    const { m } = makeManager({
      catalog: stubCatalog({
        agents: { demo: fakeAgentResolve("demo") },
        blockedAgents: { demo: { disabledByUser: true } },
      }),
    });
    await expect(m.dispatch(dispatchOf({ agent: "demo" }))).rejects.toBeInstanceOf(
      EntryNotReadyError,
    );
  });

  it("EntryNotReadyError when a transitive dep is blocked (cascade)", async () => {
    const { m } = makeManager({
      catalog: stubCatalog({
        agents: { demo: fakeAgentResolve("demo") },
        blockedAgents: {
          demo: { blockedDeps: [{ kind: "skill", fqn: "public/tool" }] },
        },
      }),
    });
    const err = await m.dispatch(dispatchOf({ agent: "demo" })).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(EntryNotReadyError);
    expect((err as EntryNotReadyError).reason?.blockedDeps).toEqual([
      { kind: "skill", fqn: "public/tool" },
    ]);
  });
});

describe("exit watcher", () => {
  it("exit code 0 → status=success, output empty, exitCode=0", async () => {
    const rt = new StubRuntime();
    const { m } = makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());

    void rt.handles[0].exit({ code: 0, signal: null });
    const after = await awaitTerminal(m, t.id);
    expect(after.status).toBe("success");
    expect(after.result?.output).toBe("");
    const meta = readTaskRuntimeMetadata(after);
    expect(meta.exitCode).toBe(0);
    expect(meta.exitSignal).toBeNull();
  });

  it("exit code != 0 → status=failure, error mentions code", async () => {
    const rt = new StubRuntime();
    const { m } = makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());

    void rt.handles[0].exit({ code: 17, signal: null });
    const after = await awaitTerminal(m, t.id);
    expect(after.status).toBe("failure");
    expect(after.failure?.error).toMatch(/exited with code 17/);
    expect(readTaskRuntimeMetadata(after).exitCode).toBe(17);
  });

  it("exit by signal → status=failure, error mentions signal", async () => {
    const rt = new StubRuntime();
    const { m } = makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());

    void rt.handles[0].exit({ code: null, signal: "SIGTERM" });
    const after = await awaitTerminal(m, t.id);
    expect(after.status).toBe("failure");
    expect(after.failure?.error).toMatch(/SIGTERM/);
    expect(readTaskRuntimeMetadata(after).exitSignal).toBe("SIGTERM");
  });
});

describe("liveCount", () => {
  // These tests pin the contract that `WorkspaceContextCache.reload`
  // depends on: liveCount must report > 0 for any task whose on-disk
  // workdir exists but has not yet reached terminal status, including
  // tasks that are mid-dispatch (workdir reserved, `live.set` not yet
  // called) and tasks rolling back due to a runtime throw. The route
  // tests in `packages/server/test/workspaces.test.ts` stub liveCount
  // directly to keep the cache-side contract isolated; this is where
  // the implementation contract itself is exercised end-to-end.

  it("returns 0 on a fresh manager with no dispatches", () => {
    const { m } = makeManager();
    expect(m.liveCount()).toBe(0);
  });

  it("counts a live task between dispatch and exit, drops back to 0 after terminal", async () => {
    const rt = new StubRuntime();
    const { m } = makeManager({ runtime: rt });

    expect(m.liveCount()).toBe(0);
    const t = await m.dispatch(dispatchOf());
    // Subprocess is alive and the LiveTask entry is installed; reload
    // should see the work and refuse.
    expect(m.liveCount()).toBe(1);

    // Drive the exit watcher to terminal and wait for the post-exit
    // persistence (which clears the LiveTask entry) to settle.
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);
    await rt.handles[0].persisted;
    expect(m.liveCount()).toBe(0);
  });

  it("returns to 0 after a dispatch failure rolls back the workdir (pins finally cleanup)", async () => {
    // This is the regression-bait test: if `dispatchInProgress.delete`
    // ever escapes the `finally` block in dispatch(), every failed
    // dispatch leaks an id and every subsequent reload() returns 409
    // even though no real work is in flight. Build + route tests pass
    // because the route stubs liveCount; only this assertion catches
    // the leak.
    const rt = new StubRuntime();
    rt.dispatchError = new Error("boom in spawn");
    const { m } = makeManager({ runtime: rt });

    expect(m.liveCount()).toBe(0);
    await expect(m.dispatch(dispatchOf())).rejects.toThrow(/boom in spawn/);
    expect(m.liveCount()).toBe(0);
  });
});

describe("get / list", () => {
  it("get() returns null for an id whose dir doesn't exist", async () => {
    const { m } = makeManager();
    expect(await m.get("20260101-deadbeef")).toBeNull();
  });

  it("get() throws InvalidTaskIdError for malformed ids", async () => {
    const { m } = makeManager();
    await expect(m.get("../escape")).rejects.toBeInstanceOf(InvalidTaskIdError);
  });

  it("list() returns [] when tasksDir doesn't exist yet", async () => {
    await rm(tasksDir, { recursive: true, force: true });
    const { m } = makeManager();
    expect(await m.list()).toEqual([]);
  });

  it("list() returns dispatched tasks newest-first", async () => {
    const rt = new StubRuntime();
    let nowMs = Date.parse("2026-05-08T01:00:00.000Z");
    const { m } = makeManager({
      runtime: rt,
      now: () => new Date(nowMs),
      // Each dispatch uses 2 random buffers (one per id-gen attempt). We
      // step the seed enough that distinct dispatches land on distinct ids.
      randomBytes: seqRandom(1),
    });
    const t1 = await m.dispatch(dispatchOf({ instructions: "first" }));
    nowMs += 60_000;
    const t2 = await m.dispatch(dispatchOf({ instructions: "second" }));
    nowMs += 60_000;
    const t3 = await m.dispatch(dispatchOf({ instructions: "third" }));

    const all = await m.list();
    expect(all.map((t) => t.id)).toEqual([t3.id, t2.id, t1.id]);
  });

  it("list() silently skips rows that fail validation and warns via the repo's logger", async () => {
    // The repo emits the corruption-skip warn now (was the manager
    // before, when each list iteration went through loadTask). Inject
    // the recorder logger into the repo and bypass the public save()
    // by reaching into the underlying DatabaseSync to forge a row
    // with an invalid status enum that rowToTask rejects.
    const r = recorder();
    const db = new DatabaseSync(":memory:");
    openDbs.push(db);
    const repo = new SqliteTaskRepository({ db, logger: r.logger });
    const { m } = makeManager({ runtime: new StubRuntime(), repository: repo });
    await m.dispatch(dispatchOf()); // good row through public API

    // Forge a row whose status is outside the closed enum; rowToTask
    // throws CorruptedTaskError → repo.list catches, drops, warns.
    const rawDb = (
      repo as unknown as {
        db: { prepare: (s: string) => { run: (...args: unknown[]) => void } };
      }
    ).db;
    rawDb
      .prepare(
        `INSERT INTO tasks (id, agent, runtime, status, instructions, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "20260101-deadbeef",
        "demo",
        "copilot",
        "bogus_status",
        "i",
        "2026-01-01T00:00:00.000Z",
        "{}",
      );

    const all = await m.list();
    expect(all).toHaveLength(1); // good row survives, bogus is dropped
    expect(r.calls.some((c) => c.msg.includes("corrupted task row"))).toBe(true);
  });

  // Companion to the list() skip+warn test: get() must NOT silently
  // 404 when the row is corrupted — operators need to see the
  // corruption (the route layer maps `CorruptedTaskError` to 5xx).
  // A silent-null path here would let the dashboard render "task gone"
  // for a tampered/bit-rotted row, and the next save would round-trip
  // an empty `{}` over the corrupt blob.
  it("get() propagates CorruptedTaskError instead of returning null", async () => {
    const repo = makeRepo();
    const { m } = makeManager({ runtime: new StubRuntime(), repository: repo });
    // Forge the same kind of bogus row the list() test uses.
    const rawDb = (
      repo as unknown as {
        db: { prepare: (s: string) => { run: (...args: unknown[]) => void } };
      }
    ).db;
    const id = "20260101-deadbeef";
    rawDb
      .prepare(
        `INSERT INTO tasks (id, agent, runtime, status, instructions, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, "demo", "copilot", "bogus_status", "i", "2026-01-01T00:00:00.000Z", "{}");
    await expect(m.get(id)).rejects.toBeInstanceOf(CorruptedTaskError);
  });

  it("list() ignores directories whose name doesn't match the task id pattern", async () => {
    const rt = new StubRuntime();
    const { m } = makeManager({ runtime: rt });
    await m.dispatch(dispatchOf());
    await mkdir(path.join(tasksDir, "garbage-dir"), { recursive: true });

    const all = await m.list();
    expect(all).toHaveLength(1);
  });

  // Server-side filter parity with @emploke/session: callers can push
  // their UI filter dimensions down so the wire payload + per-poll JSON
  // parsing scale with the visible set, not the workspace total.
  describe("list(opts) — server-side filter", () => {
    it("filters by exact agent match", async () => {
      const rt = new StubRuntime();
      const { m } = makeManager({
        runtime: rt,
        catalog: stubCatalog({
          agents: { writer: fakeAgentResolve("writer"), reviewer: fakeAgentResolve("reviewer") },
        }),
      });
      await m.dispatch(dispatchOf({ agent: "writer" }));
      await m.dispatch(dispatchOf({ agent: "reviewer" }));
      await m.dispatch(dispatchOf({ agent: "writer" }));

      const writers = await m.list({ agent: "writer" });
      expect(writers).toHaveLength(2);
      expect(writers.every((t) => t.agent === "writer")).toBe(true);
    });

    it("filters by exact runtime match (reads from metadata.runtime)", async () => {
      const copilot = new StubRuntime("copilot");
      const gemini = new StubRuntime("gemini");
      const reg = new RuntimeRegistry();
      reg.register(copilot);
      reg.register(gemini);
      const { m } = makeManager({ registry: reg, runtime: copilot });
      await m.dispatch(dispatchOf({ runtime: "copilot" }));
      await m.dispatch(dispatchOf({ runtime: "gemini" }));

      const onlyGemini = await m.list({ runtime: "gemini" });
      expect(onlyGemini).toHaveLength(1);
      expect(readTaskRuntimeMetadata(onlyGemini[0]).runtime).toBe("gemini");
    });

    it("filters by createdSince (lexicographic on ISO 8601)", async () => {
      const rt = new StubRuntime();
      let nowMs = Date.parse("2026-05-08T01:00:00.000Z");
      const { m } = makeManager({
        runtime: rt,
        now: () => new Date(nowMs),
        randomBytes: seqRandom(1),
      });
      await m.dispatch(dispatchOf({ instructions: "old" }));
      nowMs += 60_000;
      const cutoff = new Date(nowMs).toISOString();
      nowMs += 60_000;
      await m.dispatch(dispatchOf({ instructions: "new" }));

      const recent = await m.list({ createdSince: cutoff });
      expect(recent).toHaveLength(1);
      expect(recent[0].instructions).toBe("new");
    });

    it("filters by status set (running|success|failure|cancelled|not_started)", async () => {
      const rt = new StubRuntime();
      const { m } = makeManager({ runtime: rt });
      const a = await m.dispatch(dispatchOf({ instructions: "a" }));
      void rt.handles[0].exit({ code: 0, signal: null });
      await awaitTerminal(m, a.id);
      await m.dispatch(dispatchOf({ instructions: "b" })); // stays running

      const onlyRunning = await m.list({ statuses: ["running"] });
      expect(onlyRunning).toHaveLength(1);
      expect(onlyRunning[0].instructions).toBe("b");

      const onlySuccess = await m.list({ statuses: ["success"] });
      expect(onlySuccess).toHaveLength(1);
      expect(onlySuccess[0].instructions).toBe("a");

      const both = await m.list({ statuses: ["running", "success"] });
      expect(both).toHaveLength(2);
    });

    it("combines multiple filters with AND semantics", async () => {
      const rt = new StubRuntime();
      const { m } = makeManager({
        runtime: rt,
        catalog: stubCatalog({
          agents: { writer: fakeAgentResolve("writer"), reviewer: fakeAgentResolve("reviewer") },
        }),
      });
      await m.dispatch(dispatchOf({ agent: "writer", instructions: "w1" }));
      await m.dispatch(dispatchOf({ agent: "reviewer", instructions: "r1" }));
      const target = await m.dispatch(dispatchOf({ agent: "writer", instructions: "w2" }));
      void rt.handles[2].exit({ code: 0, signal: null });
      await awaitTerminal(m, target.id);

      const writersDone = await m.list({ agent: "writer", statuses: ["success"] });
      expect(writersDone).toHaveLength(1);
      expect(writersDone[0].instructions).toBe("w2");
    });
  });
});

describe("delete", () => {
  it("default delete removes metadata; workdir preserved", async () => {
    const rt = new StubRuntime();
    const { m } = makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);

    await m.delete(t.id);

    // Metadata removed (task no longer get-able).
    expect(await m.get(t.id)).toBeNull();
    // Workdir preserved (consistent with workspace/session purge=false default).
    expect(await safeStat(path.join(tasksDir, t.id))).not.toBeNull();
  });

  it("purge=true removes the entire workdir", async () => {
    const rt = new StubRuntime();
    const { m } = makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);

    await m.delete(t.id, { purge: true });

    expect(await safeStat(path.join(tasksDir, t.id))).toBeNull();
  });

  it("kills a live task before removing metadata (purge=true also removes workdir)", async () => {
    const rt = new StubRuntime();
    rt.autoExitOnKill = true;
    const { m } = makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());

    await m.delete(t.id, { purge: true });

    expect(rt.handles[0].killed).toBe(true);
    expect(await safeStat(path.join(tasksDir, t.id))).toBeNull();
  });

  // Regression for the delete/exit-watcher race: deleting a live task
  // races the kill against the exit watcher's terminal-status persist.
  // The watcher should NOT log "failed to persist terminal status"
  // when its writeFile loses to our rm — kill+rm+drain must serialise
  // cleanly.
  it("does not log 'failed to persist terminal status' when deleting a live task", async () => {
    const rt = new StubRuntime();
    rt.autoExitOnKill = true;
    const r = recorder();
    const { m } = makeManager({ runtime: rt, logger: r.logger });
    const t = await m.dispatch(dispatchOf());

    await m.delete(t.id, { purge: true });

    expect(rt.handles[0].killed).toBe(true);
    expect(await safeStat(path.join(tasksDir, t.id))).toBeNull();
    const offenders = r.calls.filter((c) => c.msg.includes("failed to persist terminal status"));
    expect(offenders).toEqual([]);
  });

  it("throws TaskNotFoundError for an unknown id", async () => {
    const { m } = makeManager();
    await expect(m.delete("20260101-deadbeef")).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  // Without `purge`, a stray workdir whose row was never persisted (or
  // was wiped) is undeletable through the public API: loadTask returns
  // null → delete throws TaskNotFoundError → operators can't clean up.
  // With `purge: true`, the directory's existence is enough (mirrors
  // `rm -rf`). Reframed from the old "corrupt task.json" version: under
  // SQLite, the equivalent escape-hatch case is "workdir on disk, no
  // row in DB" — which is the natural outcome of a row deleted out of
  // band, or a workdir created by a prior emploke version after wipe.
  it("purge: true removes a stray workdir even when no task row exists", async () => {
    const id = "20260508-c0ffee01";
    const workdir = path.join(tasksDir, id);
    await mkdir(workdir, { recursive: true });

    const { m } = makeManager();

    // Default mode: no row → loadTask returns null → not deletable.
    await expect(m.delete(id)).rejects.toBeInstanceOf(TaskNotFoundError);

    // purge=true: gone.
    await m.delete(id, { purge: true });
    expect(await safeStat(workdir)).toBeNull();
  });

  it("purge: true still returns TaskNotFoundError when the directory truly doesn't exist", async () => {
    const { m } = makeManager();
    await expect(m.delete("20260101-deadbeef", { purge: true })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });

  // Twin tests for the corrupted-row-on-delete path. Default (archive)
  // mode must surface the corruption so operators see it; purge mode
  // must tolerate it so the workdir + row can still be wiped via the
  // stat-based escape hatch (mirrors `rm -rf` semantics).
  it("default delete propagates CorruptedTaskError (operator sees the corruption)", async () => {
    const repo = makeRepo();
    const { m } = makeManager({ runtime: new StubRuntime(), repository: repo });
    const id = "20260101-deadbeef";
    const rawDb = (
      repo as unknown as {
        db: { prepare: (s: string) => { run: (...args: unknown[]) => void } };
      }
    ).db;
    rawDb
      .prepare(
        `INSERT INTO tasks (id, agent, runtime, status, instructions, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, "demo", "copilot", "bogus_status", "i", "2026-01-01T00:00:00.000Z", "{}");
    await expect(m.delete(id)).rejects.toBeInstanceOf(CorruptedTaskError);
  });

  it("purge: true tolerates a corrupted row and falls back to the stat escape hatch", async () => {
    const repo = makeRepo();
    const { m } = makeManager({ runtime: new StubRuntime(), repository: repo });
    const id = "20260101-deadbeef";
    const workdir = path.join(tasksDir, id);
    await mkdir(workdir, { recursive: true });
    const rawDb = (
      repo as unknown as {
        db: { prepare: (s: string) => { run: (...args: unknown[]) => void } };
      }
    ).db;
    rawDb
      .prepare(
        `INSERT INTO tasks (id, agent, runtime, status, instructions, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, "demo", "copilot", "bogus_status", "i", "2026-01-01T00:00:00.000Z", "{}");
    await m.delete(id, { purge: true });
    expect(await safeStat(workdir)).toBeNull();
  });

  // Mirrors SessionManager.delete({purge:true}): runtime per-task state
  // (e.g. Copilot's <copilotStateDir>/<runtimeSessionId>/) must be cleaned
  // up too, otherwise purge leaks events.jsonl + transcripts forever.
  it("purge: true asks the runtime to wipe its per-task state, with task metadata", async () => {
    const rt = new StubRuntime();
    const { m } = makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);

    expect(rt.deleteStateCalls).toEqual([]);
    await m.delete(t.id, { purge: true });

    expect(rt.deleteStateCalls).toHaveLength(1);
    expect(rt.deleteStateCalls[0].runtimeSessionId).toBe(rt.handles[0].runtimeSessionId);
  });

  // Default (archive) mode preserves runtime state — only the row is dropped,
  // not the workdir, not the runtime's events.jsonl. This matches the
  // "operators can recover the agent's product after a delete" intent.
  it("default delete does NOT call runtime.deleteState", async () => {
    const rt = new StubRuntime();
    const { m } = makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);

    await m.delete(t.id);

    expect(rt.deleteStateCalls).toEqual([]);
  });

  // Order matters: a runtime that fails to clean up its state must leave
  // the local row + workdir intact so the user can retry rather than
  // ending up with a half-deleted task whose state dir leaks.
  it("aborts BEFORE removing the row + workdir when runtime.deleteState throws", async () => {
    const rt = new StubRuntime();
    rt.deleteStateError = new Error("permission denied wiping state dir");
    const { m } = makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);

    await expect(m.delete(t.id, { purge: true })).rejects.toThrow(
      /permission denied wiping state dir/,
    );

    // Row still there, workdir still there.
    expect(await m.get(t.id)).not.toBeNull();
    expect(await safeStat(path.join(tasksDir, t.id))).not.toBeNull();
  });

  // The "stray workdir" recovery path has no metadata to read, so the
  // runtime cleanup is silently skipped. This is the rm -rf escape hatch
  // for purge — losing some runtime state is acceptable when the row's
  // gone anyway.
  it("purge: true skips runtime.deleteState when no metadata row exists", async () => {
    const id = "20260508-c0ffee02";
    const workdir = path.join(tasksDir, id);
    await mkdir(workdir, { recursive: true });

    const rt = new StubRuntime();
    const { m } = makeManager({ runtime: rt });
    await m.delete(id, { purge: true });

    expect(rt.deleteStateCalls).toEqual([]);
    expect(await safeStat(workdir)).toBeNull();
  });
});

describe("shutdown", () => {
  it("kills all live tasks and marks them failure with reason 'server shutdown'", async () => {
    const rt = new StubRuntime();
    rt.autoExitOnKill = true;
    const { m } = makeManager({ runtime: rt });

    const t1 = await m.dispatch(dispatchOf({ instructions: "a" }));
    const t2 = await m.dispatch(dispatchOf({ instructions: "b" }));

    await m.shutdown();

    const a1 = await m.get(t1.id);
    const a2 = await m.get(t2.id);
    expect(a1?.status).toBe("failure");
    expect(a2?.status).toBe("failure");
    expect(a1?.failure?.error).toBe("server shutdown");
    expect(a2?.failure?.error).toBe("server shutdown");
  });

  it("refuses new dispatch after shutdown is called", async () => {
    const rt = new StubRuntime();
    const { m } = makeManager({ runtime: rt });
    await m.shutdown();
    await expect(m.dispatch(dispatchOf())).rejects.toThrow(/shutting down/);
  });

  it("is idempotent — calling shutdown twice doesn't throw", async () => {
    const { m } = makeManager();
    await m.shutdown();
    await m.shutdown();
  });

  // Regression for REV2-T2: a task that exits cleanly with code 0 at the
  // same instant shutdown() flips the global flag should NOT be
  // mis-recorded as `failure: "server shutdown"`. Per-task `killedByUs`
  // means only tasks we actually killed get the shutdown reason; a task
  // that beat us to the punch with a clean exit still records `success`.
  it("does not misclassify a self-exiting task as 'server shutdown'", async () => {
    const rt = new StubRuntime();
    const { m } = makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());

    // Trigger the natural success exit BEFORE invoking shutdown. The
    // exit watcher's read of killedByUs happens AT exit time and sees
    // false, so the task records success regardless of what shutdown()
    // does to other live tasks.
    void rt.handles[0].exit({ code: 0, signal: null });
    const after = await awaitTerminal(m, t.id);
    expect(after.status).toBe("success");

    // Now shutdown is a no-op for this task (already terminal, dropped
    // from this.live by the watcher).
    await m.shutdown();
    const final = await m.get(t.id);
    expect(final?.status).toBe("success");
    expect(final?.failure).toBeUndefined();
  });

  // Regression for REV2-T1: a dispatch that spawns mid-shutdown must
  // not be left orphaned. The post-spawn `shuttingDown` re-check inside
  // dispatch() should kill the just-spawned subprocess and roll back
  // the workdir, surfacing the standard "shutting down" error to the
  // caller.
  it("dispatch that races with shutdown kills the subprocess and rolls back", async () => {
    const rt = new StubRuntime();
    rt.autoExitOnKill = true;
    // Hold the dispatch in `runtime.launchHeadless` long enough for
    // shutdown() to flip the flag underneath it.
    let resolveSpawn!: () => void;
    const spawnHold = new Promise<void>((r) => {
      resolveSpawn = r;
    });
    const original = rt.launchHeadless;
    Object.defineProperty(rt, "launchHeadless", {
      get:
        () =>
        async (opts: Parameters<NonNullable<typeof original>>[0]): Promise<RuntimeHandle> => {
          await spawnHold;
          if (!original) throw new Error("launchHeadless hook lost");
          return original.call(rt, opts);
        },
    });
    const { m } = makeManager({ runtime: rt });
    const dispatched = m.dispatch(dispatchOf());

    // Flip shutdown while the dispatch is parked inside spawnHold.
    // Then release dispatch: the post-spawn check fires, kill is
    // invoked, workdir is rolled back, dispatch rejects.
    setTimeout(() => {
      void m.shutdown();
      resolveSpawn();
    }, 10);

    await expect(dispatched).rejects.toThrow(/shutting down/);

    // No task dir survives.
    const entries = await safeReaddir(tasksDir);
    expect(entries.filter((e) => /^\d{8}-/.test(e))).toEqual([]);
  });
});

describe("recoverOrphaned", () => {
  it("marks running tasks as failure with reason 'orphaned (...)'", async () => {
    // Hand-craft an on-disk running task without going through dispatch.
    // Use a PID we just spawned and reaped so `isProcessAlive` is
    // guaranteed to return false (a hardcoded constant like 99999 might
    // happen to be alive on a long-running dev machine).
    const deadPid = await spawnAndReap();
    const id = "20260508-deadbeef";
    const workdir = path.join(tasksDir, id);
    await mkdir(workdir, { recursive: true });
    const orphan = Task.fromStored({
      id,
      agent: "demo",
      instructions: "do something",
      status: "running",
      metadata: { pid: deadPid, runtime: "copilot" },
      createdAt: "2026-05-08T01:00:00.000Z",
      startedAt: "2026-05-08T01:00:01.000Z",
    });
    const { m, repo } = makeManager();
    await repo.save(orphan);

    await m.recoverOrphaned();

    const after = await m.get(id);
    expect(after?.status).toBe("failure");
    expect(after?.failure?.error).toMatch(/orphaned/);
  });

  it("leaves terminal tasks unchanged", async () => {
    const id = "20260508-cafef00d";
    const workdir = path.join(tasksDir, id);
    await mkdir(workdir, { recursive: true });
    const done = Task.fromStored({
      id,
      agent: "demo",
      instructions: "did it",
      status: "success",
      metadata: {},
      createdAt: "2026-05-08T01:00:00.000Z",
      startedAt: "2026-05-08T01:00:01.000Z",
      endedAt: "2026-05-08T01:00:02.000Z",
      result: { output: "ok" },
    });
    const { m, repo } = makeManager();
    await repo.save(done);

    await m.recoverOrphaned();

    const after = await m.get(id);
    expect(after?.status).toBe("success");
    expect(after?.result?.output).toBe("ok");
  });

  it("is a no-op when the tasks directory doesn't exist", async () => {
    await rm(tasksDir, { recursive: true, force: true });
    const { m } = makeManager();
    await expect(m.recoverOrphaned()).resolves.toBeUndefined();
  });

  // Live-PID guard: a `running` task whose recorded PID is still alive
  // (i.e. the subprocess somehow outlived the server crash) must NOT be
  // flipped to failure — incorrectly marking a still-active task as
  // failed is worse than leaving a stale `running` row, because the
  // subprocess may still be writing real output into the workdir. We
  // log a warn so operators see the live orphan exists.
  it("does not flip a running task whose recorded PID is still alive", async () => {
    const liveChild = nodeSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const livePid = liveChild.pid as number;
    expect(livePid).toBeGreaterThan(0);
    try {
      const id = "20260508-aaaaaaaa";
      const workdir = path.join(tasksDir, id);
      await mkdir(workdir, { recursive: true });
      const orphan = Task.fromStored({
        id,
        agent: "demo",
        instructions: "do something",
        status: "running",
        metadata: { pid: livePid, runtime: "copilot" },
        createdAt: "2026-05-08T01:00:00.000Z",
        startedAt: "2026-05-08T01:00:01.000Z",
      });

      const r = recorder();
      const { m, repo } = makeManager({ logger: r.logger });
      await repo.save(orphan);
      await m.recoverOrphaned();

      const after = await m.get(id);
      expect(after?.status).toBe("running");
      expect(after?.failure).toBeUndefined();
      expect(r.calls.some((c) => c.msg.includes("skipping live orphan"))).toBe(true);
    } finally {
      liveChild.kill();
    }
  });

  // Pre-PID-probe records (no `metadata.pid`) get the conservative
  // treatment: assume dead, mark failure. Same behaviour as before
  // Y3, ensuring we don't introduce a "running forever" regression
  // for tasks dispatched by older builds.
  it("marks a running task with no recorded PID as failure", async () => {
    const id = "20260508-bbbbbbbb";
    const workdir = path.join(tasksDir, id);
    await mkdir(workdir, { recursive: true });
    const orphan = Task.fromStored({
      id,
      agent: "demo",
      instructions: "do something",
      status: "running",
      metadata: { runtime: "copilot" }, // no pid
      createdAt: "2026-05-08T01:00:00.000Z",
      startedAt: "2026-05-08T01:00:01.000Z",
    });
    const { m, repo } = makeManager();
    await repo.save(orphan);

    await m.recoverOrphaned();

    const after = await m.get(id);
    expect(after?.status).toBe("failure");
    expect(after?.failure?.error).toMatch(/orphaned/);
  });
});

// ───── small fs helpers ────────────────────────────────────

async function safeStat(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

async function safeReaddir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  { tries = 50, betweenMs = 5 }: { tries?: number; betweenMs?: number } = {},
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, betweenMs));
  }
  throw new Error(`waitFor: predicate never became true after ${tries} tries`);
}

/** Poll the manager until the task has reached a terminal status. */
async function awaitTerminal(m: TaskManager, id: string): Promise<Task> {
  let last: Task | null = null;
  await waitFor(async () => {
    last = await m.get(id);
    if (last === null) return false;
    return last.status !== "running" && last.status !== "not_started";
  });
  if (last === null) throw new Error(`awaitTerminal: task ${id} not found`);
  return last;
}

/**
 * Spawn a tiny short-lived child, wait for it to exit, and return its
 * PID. The PID is then guaranteed to refer to a *dead* process for the
 * lifetime of the test (PID reuse on the same runner within the test
 * window is theoretically possible but vanishingly unlikely; if it
 * becomes a flake later, retry with a small loop until probe says dead).
 */
async function spawnAndReap(): Promise<number> {
  const child = nodeSpawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid as number;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("spawnAndReap: child has no pid");
  }
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

// ═════ subprocess env injection ═════════════════════════════════
//
// Fixes the v0.3.2 footgun where AI-agent harnesses lost their
// EMPLOKE_WORKSPACE between tool calls because each call ran in a
// fresh shell. Env injection guarantees every task subprocess and
// any child it spawns inherits the bag, so `emploke ...` calls made
// from inside a task automatically know which workspace they belong
// to without the human/agent having to set anything.
//
// Concurrency-safety contract (these tests pin it):
//   1. The base bag passed at construction is shared by reference
//      across all dispatches; it is NOT mutated by dispatch.
//   2. Each dispatch builds a FRESH per-task object on top of the
//      base — never reuses a previous dispatch's object.
//   3. Per-task fields (EMPLOKE_WORK_ID) are unique per dispatch.
//   4. Per-workspace fields (EMPLOKE_WORKSPACE, EMPLOKE_WORKSPACE_DIR)
//      come from the manager's own immutable config.
//   5. Two managers built for two different workspaces, dispatching
//      concurrently, must produce disjoint env bags — no leakage.

describe("dispatch — subprocess env injection", () => {
  it("threads workspaceId, workspaceDir, taskId into runtime.launchHeadless as EMPLOKE_* vars", async () => {
    const rt = new StubRuntime();
    const { m } = makeManager({
      runtime: rt,
      workspaceId: "ws-uuid-alpha",
      subprocessEnv: { EMPLOKE_SERVER: "http://127.0.0.1:8787" },
    });
    const t = await m.dispatch(dispatchOf({ agent: "demo", instructions: "go" }));

    expect(rt.dispatchCalls).toHaveLength(1);
    const env = rt.dispatchCalls[0].subprocessEnv;
    expect(env).toBeDefined();
    expect(env?.EMPLOKE_SERVER).toBe("http://127.0.0.1:8787");
    expect(env?.EMPLOKE_WORKSPACE).toBe("ws-uuid-alpha");
    // workspaceDir defaults to tasksDir in the test harness.
    expect(env?.EMPLOKE_WORKSPACE_DIR).toBe(tasksDir);
    expect(env?.EMPLOKE_WORK_KIND).toBe("task");
    expect(env?.EMPLOKE_WORK_ID).toBe(t.id);
    // Per-task workdir lives at <tasksDir>/<id>/ — it's the cwd the
    // runtime spawns into AND the value an agent should treat as
    // "my own outputs go here".
    expect(env?.EMPLOKE_WORK_DIR).toBe(rt.dispatchCalls[0].workdir);
  });

  it("omits EMPLOKE_WORKSPACE when no workspaceId is configured (back-compat)", async () => {
    const rt = new StubRuntime();
    const { m } = makeManager({ runtime: rt });
    await m.dispatch(dispatchOf({ agent: "demo", instructions: "go" }));

    const env = rt.dispatchCalls[0].subprocessEnv;
    expect(env).toBeDefined();
    expect("EMPLOKE_WORKSPACE" in (env ?? {})).toBe(false);
    // Per-task fields are still set even without a workspaceId.
    expect(env?.EMPLOKE_WORKSPACE_DIR).toBe(tasksDir);
    expect(env?.EMPLOKE_WORK_ID).toMatch(/^\d{8}-[0-9a-f]{8}$/);
  });

  it("two concurrent dispatches on the same manager get disjoint EMPLOKE_WORK_IDs (no shared bag)", async () => {
    const rt = new StubRuntime();
    const { m } = makeManager({
      runtime: rt,
      workspaceId: "ws-uuid-1",
      randomBytes: seqRandom(),
    });
    const [t1, t2] = await Promise.all([
      m.dispatch(dispatchOf({ agent: "demo", instructions: "a" })),
      m.dispatch(dispatchOf({ agent: "demo", instructions: "b" })),
    ]);

    expect(t1.id).not.toBe(t2.id);
    expect(rt.dispatchCalls).toHaveLength(2);
    const ids = rt.dispatchCalls.map((c) => c.subprocessEnv?.EMPLOKE_WORK_ID);
    expect(new Set(ids).size).toBe(2);
    // Both should belong to the same workspace.
    for (const c of rt.dispatchCalls) {
      expect(c.subprocessEnv?.EMPLOKE_WORKSPACE).toBe("ws-uuid-1");
    }
    // The two env objects are distinct instances — proves we don't
    // reuse a memoised per-manager bag.
    expect(rt.dispatchCalls[0].subprocessEnv).not.toBe(rt.dispatchCalls[1].subprocessEnv);
  });

  it("two managers for two workspaces produce strictly isolated env bags", async () => {
    // Same shared base (mimics what WorkspaceContextCache does in
    // production: one frozen base passed by reference into every
    // per-workspace manager). Concurrency-safety means workspace A's
    // dispatch and workspace B's dispatch must NEVER cross-contaminate
    // — even though they share the base bag by reference.
    const sharedBase = Object.freeze({ EMPLOKE_SERVER: "http://127.0.0.1:8787" });

    const rtA = new StubRuntime();
    const { m: managerA } = makeManager({
      runtime: rtA,
      workspaceId: "ws-A",
      subprocessEnv: sharedBase,
    });

    const rtB = new StubRuntime();
    const { m: managerB } = makeManager({
      runtime: rtB,
      workspaceId: "ws-B",
      subprocessEnv: sharedBase,
    });

    await Promise.all([
      managerA.dispatch(dispatchOf({ agent: "demo", instructions: "x" })),
      managerB.dispatch(dispatchOf({ agent: "demo", instructions: "y" })),
    ]);

    expect(rtA.dispatchCalls[0].subprocessEnv?.EMPLOKE_WORKSPACE).toBe("ws-A");
    expect(rtB.dispatchCalls[0].subprocessEnv?.EMPLOKE_WORKSPACE).toBe("ws-B");
    // Frozen base survived without mutation: still has only the
    // server URL, no workspace fields leaked into it.
    expect(Object.keys(sharedBase)).toEqual(["EMPLOKE_SERVER"]);
    // Both dispatches saw the shared base layered correctly.
    expect(rtA.dispatchCalls[0].subprocessEnv?.EMPLOKE_SERVER).toBe("http://127.0.0.1:8787");
    expect(rtB.dispatchCalls[0].subprocessEnv?.EMPLOKE_SERVER).toBe("http://127.0.0.1:8787");
  });

  it("layered fields override base values (per-task wins over server-default)", async () => {
    // Pathological config: base accidentally has a stale workspace
    // pinned. The manager's own workspaceId must still win — base is
    // a default, not a hard pin.
    const rt = new StubRuntime();
    const { m } = makeManager({
      runtime: rt,
      workspaceId: "real-workspace",
      subprocessEnv: {
        EMPLOKE_WORKSPACE: "stale-from-base",
        EMPLOKE_SERVER: "http://127.0.0.1:8787",
      },
    });
    await m.dispatch(dispatchOf({ agent: "demo", instructions: "x" }));
    const env = rt.dispatchCalls[0].subprocessEnv;
    expect(env?.EMPLOKE_WORKSPACE).toBe("real-workspace");
    expect(env?.EMPLOKE_SERVER).toBe("http://127.0.0.1:8787");
  });

  it("preserves explicit `undefined` values from the base bag through dispatch (EMPLOKE_HOME scrub)", async () => {
    // Middle-hop regression test for the EMPLOKE_HOME scrub. The
    // server emits `EMPLOKE_HOME: undefined` in `buildSubprocessEnvBase`
    // so that `mergeEnv` (in launch-headless.ts) deletes the inherited
    // value at spawn time. That contract relies on the `undefined`
    // surviving every intermediate hop:
    //   buildSubprocessEnvBase  -> base bag with `EMPLOKE_HOME: undefined`
    //   TaskManager construction -> `subprocessEnvBase` field
    //   dispatch()              -> spread `{ ...this.subprocessEnvBase, ... }`
    //   runtime.launchHeadless  -> `opts.subprocessEnv`
    //   mergeEnv                -> deletes from inherited base
    //
    // If any intermediate strips `undefined` (e.g. via
    // `JSON.parse(JSON.stringify(...))`, `Object.assign` semantics
    // disagreements, or an over-eager normalisation pass), the scrub
    // silently breaks and the parent's `EMPLOKE_HOME` leaks through to
    // every spawned task. This test pins the spread + reference path
    // through the manager.
    const rt = new StubRuntime();
    const { m } = makeManager({
      runtime: rt,
      workspaceId: "ws-uuid-x",
      subprocessEnv: Object.freeze({
        EMPLOKE_SERVER: "http://127.0.0.1:8787",
        EMPLOKE_SHARED_DIR: "/h/shared",
        EMPLOKE_HOME: undefined,
      }) as NodeJS.ProcessEnv,
    });
    await m.dispatch(dispatchOf({ agent: "demo", instructions: "x" }));
    const env = rt.dispatchCalls[0].subprocessEnv ?? {};
    expect("EMPLOKE_HOME" in env).toBe(true);
    expect(env.EMPLOKE_HOME).toBeUndefined();
  });
});
