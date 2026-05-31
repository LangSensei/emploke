import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentResolveResult, CatalogService } from "@emploke/catalog";
import type { LaunchCommand, Runtime, RuntimeHandle } from "@emploke/runtime";
import { RuntimeRegistry } from "@emploke/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Controllable rm-failure switch, shared with the node:fs/promises mock
// below. Off by default (delegates to the real rm); a test flips it on
// to exercise the `workdir rm failed` warn path in task-service.
// Hoisted because vi.mock factories run before module-scope code.
const rmFail = vi.hoisted(() => ({ enabled: false, error: null as Error | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: (async (...args: Parameters<typeof actual.rm>) => {
      if (rmFail.enabled && rmFail.error !== null) {
        const e = rmFail.error;
        rmFail.enabled = false;
        rmFail.error = null;
        throw e;
      }
      return actual.rm(...args);
    }) as typeof actual.rm,
  };
});

import {
  AgentNotFoundError,
  assertFramingPromptIsSafe,
  CorruptedTaskError,
  type DispatchOpts,
  EntryNotReadyError,
  formatTaskMd,
  InvalidTaskIdError,
  RuntimeDoesNotSupportTasksError,
  readTaskRuntimeMetadata,
  TASK_ARTIFACT_SUBDIR,
  TASK_FILENAME,
  TASK_FRAMING_PROMPT_COPILOT,
  TASK_TEMP_SUBDIR,
  TaskNotFoundError,
  TaskService,
} from "../src/index.js";
import { TaskEntity } from "../src/task-entity.js";
import { TaskRepository } from "../src/task-repository.js";
import { openTestTaskDb } from "../src/testing.js";

// ───── filesystem fixture lifecycle ────────────────────────

let tasksDir: string;
let workspaceDir: string;
const openHandles: ReturnType<typeof openTestTaskDb>[] = [];

function makeOrm(): ReturnType<typeof openTestTaskDb> {
  const orm = openTestTaskDb();
  openHandles.push(orm);
  return orm;
}

function makeRepo(): { repo: TaskRepository; orm: ReturnType<typeof openTestTaskDb> } {
  const orm = makeOrm();
  return { repo: new TaskRepository({ db: orm.db }), orm };
}

beforeEach(async () => {
  // tasksDir is `<workspaceDir>/tasks` (computed by TaskService internally
  // from workspaceDir). Tests reference it for assertions on task workdirs.
  workspaceDir = await mkdtemp(path.join(tmpdir(), "emploke-tasks-ws-"));
  tasksDir = path.join(workspaceDir, "tasks");
  await mkdir(tasksDir, { recursive: true });
});
afterEach(async () => {
  for (const o of openHandles.splice(0)) {
    try {
      o.close();
    } catch {
      // already closed
    }
  }
  await rm(workspaceDir, { recursive: true, force: true });
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

function stubCatalog(opts: StubCatalogOpts = {}): CatalogService {
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
        } as unknown as ReturnType<CatalogService["getAgentEntry"]> extends Promise<infer T>
          ? T
          : never;
      }
      return { agent: { fqn: name } as unknown, status: "ready" as const } as unknown as ReturnType<
        CatalogService["getAgentEntry"]
      > extends Promise<infer T>
        ? T
        : never;
    },
  } as unknown as CatalogService;
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

  /**
   * Optional canned response for `readMetadata`. When undefined the
   * stub omits the `readMetadata` method entirely (mirroring runtimes
   * that don't expose display metadata). Set to a literal value to
   * exercise the manager's enrichment path; tests assert that
   * `metadata.title` / `metadata.userTitled` are NOT injected into
   * the task even when the runtime supplies them — the task
   * `brief` field is the source of truth post-#111.
   */
  readMetadataResponse: import("@emploke/runtime").RuntimeSessionMetadata | null | undefined =
    undefined;

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

  // readMetadata is only exposed when a canned response is configured,
  // so tests that don't care about enrichment look like runtimes that
  // simply don't implement the optional surface.
  get readMetadata(): Runtime["readMetadata"] | undefined {
    if (this.readMetadataResponse === undefined) return undefined;
    return async () => {
      this.readMetadataCallCount++;
      return this.readMetadataResponse ?? null;
    };
  }

  /**
   * Optional canned response for `readActivity`. When undefined the
   * stub omits `readActivity` (mirroring runtimes that don't expose
   * structured activity). Set to an `ActivityResult` literal to
   * exercise the manager's #181 `applyTerminal` payload assembly.
   * Per-call invocation counter so #180 tests can assert
   * "list() never called readActivity".
   */
  readActivityResponse: import("@emploke/runtime").ActivityResult | null | undefined = undefined;
  readActivityError: Error | null = null;
  readActivityCallCount = 0;
  get readActivity(): Runtime["readActivity"] | undefined {
    if (this.readActivityResponse === undefined && this.readActivityError === null)
      return undefined;
    return async () => {
      this.readActivityCallCount++;
      if (this.readActivityError !== null) {
        const e = this.readActivityError;
        throw e;
      }
      return this.readActivityResponse ?? null;
    };
  }

  /**
   * Optional canned response for `getLastAgentActivity`. Mirrors the
   * shape of {@link readActivityResponse}: undefined → method absent
   * (runtime doesn't implement the surface), null → method present
   * but no agent activity yet, value → returned as-is.
   *
   * When `getLastAgentActivityResponse` is undefined but
   * `readActivityResponse` is set, this stub auto-derives the agent
   * activity from the canned activity stream so existing tests that
   * only configure `readActivityResponse` keep exercising the
   * `collectSuccessPayload` path.
   */
  getLastAgentActivityResponse: import("@emploke/runtime").AgentActivity | null | undefined =
    undefined;
  getLastAgentActivityError: Error | null = null;
  getLastAgentActivityCallCount = 0;
  get getLastAgentActivity(): Runtime["getLastAgentActivity"] | undefined {
    const hasExplicit =
      this.getLastAgentActivityResponse !== undefined || this.getLastAgentActivityError !== null;
    const hasDerived = this.readActivityResponse !== undefined || this.readActivityError !== null;
    if (!hasExplicit && !hasDerived) return undefined;
    return async () => {
      this.getLastAgentActivityCallCount++;
      if (this.getLastAgentActivityError !== null) {
        const e = this.getLastAgentActivityError;
        throw e;
      }
      if (hasExplicit) return this.getLastAgentActivityResponse ?? null;
      // Auto-derive from the readActivity stream — same predicate the
      // copilot runtime applies (last assistant item wins).
      if (this.readActivityError !== null) {
        const e = this.readActivityError;
        throw e;
      }
      const result = this.readActivityResponse ?? null;
      if (result === null) return null;
      for (let i = result.activity.length - 1; i >= 0; i--) {
        const item = result.activity[i];
        if (item !== undefined && item.kind === "assistant") {
          return { text: item.text, timestamp: item.timestamp };
        }
      }
      return null;
    };
  }

  /** Per-call invocation counter for #180 assertions. */
  readMetadataCallCount = 0;

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
  // pulled from `pino (was @emploke/logger; pkg folded into consumers)/testing.captureLogger` because these
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
  brief: "Do the thing.",
  ...overrides,
});

const makeManager = async (
  overrides: {
    catalog?: CatalogService;
    runtime?: Runtime;
    registry?: RuntimeRegistry;
    now?: () => Date;
    randomBytes?: (n: number) => Buffer;
    logger?: { warn: (meta: object | string, msg?: string) => void };
    repository?: TaskRepository;
    orm?: ReturnType<typeof openTestTaskDb>;
    workspaceId?: string;
    subprocessEnv?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ m: TaskService; repo: TaskRepository; orm: ReturnType<typeof openTestTaskDb> }> => {
  const rt = overrides.runtime ?? new StubRuntime();
  const registry = overrides.registry ?? makeRegistry(rt);
  let orm: ReturnType<typeof openTestTaskDb>;
  let repo: TaskRepository;
  if (overrides.orm !== undefined) {
    orm = overrides.orm;
    repo = overrides.repository ?? new TaskRepository({ db: orm.db });
  } else if (overrides.repository !== undefined) {
    // Caller built a custom repo + ORM elsewhere; reuse them.
    throw new Error("makeManager: pass `orm` alongside `repository`");
  } else {
    const built = makeRepo();
    orm = built.orm;
    repo = built.repo;
  }
  const m = new TaskService({
    catalog: overrides.catalog ?? stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
    runtimeRegistry: registry,
    workspaceDir,
    workspaceId: overrides.workspaceId ?? "default-ws-id",
    now: overrides.now ?? fixedNow("2026-05-08T01:05:00.000Z"),
    randomBytes: overrides.randomBytes ?? seqRandom(),
    logger: overrides.logger,
    db: orm.db,
    ...(overrides.subprocessEnv !== undefined ? { subprocessEnv: overrides.subprocessEnv } : {}),
  });
  return { m, repo, orm };
};

// ═════ tests ════════════════════════════════════════════════

describe("dispatch — happy path", () => {
  it("creates dir, persists running task to repository, populates runtime metadata, returns TaskEntity", async () => {
    const rt = new StubRuntime();
    const { m, repo } = await makeManager({ runtime: rt });

    const t = await m.dispatch(
      dispatchOf({ agent: "demo", brief: "Plant a tree.", details: "Choose oak." }),
    );

    expect(t.agent).toBe("demo");
    expect(t.brief).toBe("Plant a tree.");
    expect(t.details).toBe("Choose oak.");
    expect(t.status).toBe("running");
    expect(t.startedAt).toBe("2026-05-08T01:05:00.000Z");
    expect(t.id).toMatch(/^\d{8}-[0-9a-f]{8}$/);

    expect(rt.dispatchCalls).toHaveLength(1);
    // Per issue #109: the user's task body is no longer passed via
    // the spawn argv — it lives in `<workdir>/TASK.md`. The runtime
    // receives only the fixed framing prompt.
    expect(rt.dispatchCalls[0].prompt).toBe(TASK_FRAMING_PROMPT_COPILOT);

    const meta = readTaskRuntimeMetadata(t);
    expect(meta.workdir).toBe(path.join(tasksDir, t.id));
    expect(meta.runtime).toBe("copilot");
    expect(meta.runtimeSessionId).toBe(rt.handles[0].runtimeSessionId);

    // The task row in the repository matches the returned in-memory
    // task. (Replaces the old per-workdir `task.json` round-trip.)
    const persisted = await repo.read(t.id);
    expect(persisted?.status).toBe("running");
    expect(persisted?.id).toBe(t.id);
    expect(persisted?.brief).toBe("Plant a tree.");
    expect(persisted?.details).toBe("Choose oak.");
  });

  it("dispatch defaults details to undefined when omitted", async () => {
    const rt = new StubRuntime();
    const { m, repo } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf({ brief: "Just the brief" }));
    expect(t.details).toBeUndefined();
    const persisted = await repo.read(t.id);
    expect(persisted?.details).toBeUndefined();
  });
});

// ───── issue #109: file-based brief + details + workdir contract ─────

describe("dispatch — TASK.md + workdir contract (issue #109)", () => {
  it("writes <workdir>/TASK.md as `# <brief>\\n` when no details given (UTF-8, no BOM)", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });

    const t = await m.dispatch(dispatchOf({ agent: "demo", brief: "Plant a tree" }));
    const meta = readTaskRuntimeMetadata(t);
    const taskMdPath = path.join(meta.workdir as string, TASK_FILENAME);
    const buf = await readFile(taskMdPath);
    expect(buf[0]).not.toBe(0xef); // no UTF-8 BOM
    expect(buf.equals(Buffer.from("# Plant a tree\n", "utf8"))).toBe(true);
  });

  it("writes <workdir>/TASK.md as `# <brief>\\n\\n<details>\\n` when details given", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });

    // Multi-line + multi-byte UTF-8 (CJK + emoji) covers two things:
    //   1. LF inside details used to corrupt the spawn argv on
    //      Windows (Bug A in #109). Now LF is fine in TASK.md.
    //   2. Non-ASCII bytes round-trip cleanly through writeFile.
    const details = "Line one.\nLine two.\n你好 🌳";
    const t = await m.dispatch(dispatchOf({ agent: "demo", brief: "Plant a tree", details }));
    const meta = readTaskRuntimeMetadata(t);
    const taskMdPath = path.join(meta.workdir as string, TASK_FILENAME);
    const buf = await readFile(taskMdPath);
    expect(buf[0]).not.toBe(0xef); // no UTF-8 BOM
    const expected = `# Plant a tree\n\n${details}\n`;
    expect(buf.equals(Buffer.from(expected, "utf8"))).toBe(true);
  });

  it("creates <workdir>/temp/ and <workdir>/artifact/ as empty directories", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });

    const t = await m.dispatch(dispatchOf({ agent: "demo", brief: "x" }));
    const meta = readTaskRuntimeMetadata(t);
    const wd = meta.workdir as string;

    const tempStat = await stat(path.join(wd, TASK_TEMP_SUBDIR));
    const artifactStat = await stat(path.join(wd, TASK_ARTIFACT_SUBDIR));
    expect(tempStat.isDirectory()).toBe(true);
    expect(artifactStat.isDirectory()).toBe(true);

    expect(await readdir(path.join(wd, TASK_TEMP_SUBDIR))).toEqual([]);
    expect(await readdir(path.join(wd, TASK_ARTIFACT_SUBDIR))).toEqual([]);
  });

  it("passes the framing prompt (NOT the user-supplied bytes) as the runtime spawn prompt", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });

    // Details that would have triggered Bug A — embedded LF, would
    // have truncated the cmd.exe argv on Windows.
    await m.dispatch(
      dispatchOf({
        agent: "demo",
        brief: "multi-line input",
        details: "first line\nsecond line\nthird line",
      }),
    );

    expect(rt.dispatchCalls).toHaveLength(1);
    const sentPrompt = rt.dispatchCalls[0].prompt;
    // Exactly the fixed copilot framing prompt — no user bytes leak in.
    expect(sentPrompt).toBe(TASK_FRAMING_PROMPT_COPILOT);
    expect(sentPrompt.includes("\n")).toBe(false);
    expect(sentPrompt.includes("\r")).toBe(false);
    expect(/[^\x20-\x7E]/.test(sentPrompt)).toBe(false);
  });
});

describe("framing prompt invariant guard", () => {
  it("accepts a single-line printable-ASCII string", () => {
    expect(() => assertFramingPromptIsSafe("hello world 123 .,;:!?")).not.toThrow();
  });

  it("rejects an LF-containing string", () => {
    expect(() => assertFramingPromptIsSafe("line1\nline2")).toThrow(/single-line printable ASCII/);
  });

  it("rejects a CR-containing string", () => {
    expect(() => assertFramingPromptIsSafe("line1\rline2")).toThrow(/single-line printable ASCII/);
  });

  it("rejects a non-ASCII byte (e.g. CJK)", () => {
    expect(() => assertFramingPromptIsSafe("hello 你好")).toThrow(/single-line printable ASCII/);
  });

  it("rejects a control byte (e.g. tab)", () => {
    expect(() => assertFramingPromptIsSafe("col1\tcol2")).toThrow(/single-line printable ASCII/);
  });

  it("the production copilot framing prompt itself passes the guard", () => {
    expect(() => assertFramingPromptIsSafe(TASK_FRAMING_PROMPT_COPILOT)).not.toThrow();
  });
});

describe("formatTaskMd", () => {
  // brief-only and brief+details produce the canonical TASK.md
  // shapes the agent contract relies on. Empty / undefined details
  // collapse to the brief-only shape — an empty body would just
  // leave a confusing dangling blank section after the `# brief\n\n`
  // header.
  it("renders brief-only as `# <brief>\\n` (no body, no blank line)", () => {
    expect(formatTaskMd("Plant a tree", undefined)).toBe("# Plant a tree\n");
  });

  it("treats empty-string details as brief-only", () => {
    expect(formatTaskMd("Plant a tree", "")).toBe("# Plant a tree\n");
  });

  it("renders brief + details as `# <brief>\\n\\n<details>\\n`", () => {
    expect(formatTaskMd("Plant a tree", "Choose oak")).toBe("# Plant a tree\n\nChoose oak\n");
  });

  it("does not double up trailing newlines when details already ends with LF", () => {
    expect(formatTaskMd("Plant a tree", "Choose oak\n")).toBe("# Plant a tree\n\nChoose oak\n");
  });

  it("preserves multi-line details verbatim under the header", () => {
    const body = "Step 1: pick site.\nStep 2: dig.\n\nStep 3: water weekly.";
    expect(formatTaskMd("Plant a tree", body)).toBe(`# Plant a tree\n\n${body}\n`);
  });

  it("preserves multi-byte UTF-8 in details (CJK, emoji)", () => {
    expect(formatTaskMd("Plant", "你好 🌳")).toBe("# Plant\n\n你好 🌳\n");
  });
});

describe("dispatch — error paths", () => {
  it("AgentNotFoundError when catalog cannot resolve the agent", async () => {
    const { m } = await makeManager({
      catalog: stubCatalog({ resolveError: new Error("nope") }),
    });
    await expect(m.dispatch(dispatchOf())).rejects.toBeInstanceOf(AgentNotFoundError);
    // No directory should have been created.
    const entries = await safeReaddir(tasksDir);
    expect(entries).toEqual([]);
  });

  it("AgentNotFoundError when caller passes empty/invalid agent name", async () => {
    const { m } = await makeManager();
    await expect(m.dispatch(dispatchOf({ agent: "" }))).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it("re-throws a foreign AgentNotFoundError (matched by name) without re-wrapping it", async () => {
    // Simulates a sibling `AgentNotFoundError` thrown from `@emploke/schedule`
    // or `@emploke/session`: same constructor name, but not an instance of
    // the task-package class. The dispatch guard must match by name string
    // so the typed boundary survives across packages (TODO(#tier-b): hoist
    // AgentNotFoundError to @emploke/catalog so the name guard isn't needed).
    const foreign = new Error("agent not found in schedule package");
    foreign.name = "AgentNotFoundError";
    const { m } = await makeManager({
      catalog: stubCatalog({ resolveError: foreign }),
    });
    const err = await m.dispatch(dispatchOf()).then(
      () => null,
      (e) => e,
    );
    // Original foreign error surfaces unchanged — not wrapped in the
    // task-package AgentNotFoundError.
    expect(err).toBe(foreign);
    expect((err as Error).name).toBe("AgentNotFoundError");
    expect(err instanceof AgentNotFoundError).toBe(false);
  });

  it("RuntimeDoesNotSupportTasksError when chosen runtime omits dispatch", async () => {
    const rt = new StubRuntime();
    rt.dispatchSupported = false;
    const { m } = await makeManager({ runtime: rt });
    await expect(m.dispatch(dispatchOf())).rejects.toBeInstanceOf(RuntimeDoesNotSupportTasksError);
    const entries = await safeReaddir(tasksDir);
    expect(entries).toEqual([]);
  });

  it("rolls back the workdir when the runtime throws during dispatch", async () => {
    const rt = new StubRuntime();
    rt.dispatchError = new Error("boom in spawn");
    const { m } = await makeManager({ runtime: rt });

    await expect(m.dispatch(dispatchOf())).rejects.toThrow(/boom in spawn/);
    const entries = await safeReaddir(tasksDir);
    expect(entries).toEqual([]);
  });

  it("EntryNotReadyError when the agent is blocked due to prereqs", async () => {
    const { m } = await makeManager({
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
    const { m } = await makeManager({
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
    const { m } = await makeManager({
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
  it("exit code 0 → status=success, output null, exitCode=0", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());

    void rt.handles[0].exit({ code: 0, signal: null });
    const after = await awaitTerminal(m, t.id);
    expect(after.status).toBe("succeeded");
    expect(after.success?.output).toBeNull();
    // v4 (issue #119) stopped mirroring exitCode/exitSignal into
    // metadata; the success path has no per-exit telemetry to record.
    const meta = readTaskRuntimeMetadata(after);
    expect(meta.exitCode).toBeUndefined();
    expect(meta.exitSignal).toBeUndefined();
  });

  it("exit code != 0 → status=failure, error mentions code", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());

    void rt.handles[0].exit({ code: 17, signal: null });
    const after = await awaitTerminal(m, t.id);
    expect(after.status).toBe("failed");
    expect(after.failure?.kind).toBe("exited");
    expect(after.failure?.message).toMatch(/exited with code 17/);
    if (after.failure?.kind === "exited") {
      expect(after.failure.exit_code).toBe(17);
    }
    expect(readTaskRuntimeMetadata(after).exitCode).toBeUndefined();
  });

  it("exit by signal → status=failure, error mentions signal", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());

    void rt.handles[0].exit({ code: null, signal: "SIGTERM" });
    const after = await awaitTerminal(m, t.id);
    expect(after.status).toBe("failed");
    expect(after.failure?.kind).toBe("signal");
    expect(after.failure?.message).toMatch(/SIGTERM/);
    if (after.failure?.kind === "signal") {
      expect(after.failure.signal).toBe("SIGTERM");
    }
    expect(readTaskRuntimeMetadata(after).exitSignal).toBeUndefined();
  });
});

describe("liveCount", () => {
  // These tests pin the contract that `WorkspaceContextRegistry.reload`
  // depends on: liveCount must report > 0 for any task whose on-disk
  // workdir exists but has not yet reached terminal status, including
  // tasks that are mid-dispatch (workdir reserved, `live.set` not yet
  // called) and tasks rolling back due to a runtime throw. The route
  // tests in `packages/server/test/workspaces.test.ts` stub liveCount
  // directly to keep the cache-side contract isolated; this is where
  // the implementation contract itself is exercised end-to-end.

  it("returns 0 on a fresh manager with no dispatches", async () => {
    const { m } = await makeManager();
    expect(m.liveCount()).toBe(0);
  });

  it("counts a live task between dispatch and exit, drops back to 0 after terminal", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });

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
    const { m } = await makeManager({ runtime: rt });

    expect(m.liveCount()).toBe(0);
    await expect(m.dispatch(dispatchOf())).rejects.toThrow(/boom in spawn/);
    expect(m.liveCount()).toBe(0);
  });
});

describe("get / list", () => {
  it("get() returns null for an id whose dir doesn't exist", async () => {
    const { m } = await makeManager();
    expect(await m.get("20260101-deadbeef")).toBeNull();
  });

  it("get() throws InvalidTaskIdError for malformed ids", async () => {
    const { m } = await makeManager();
    await expect(m.get("../escape")).rejects.toBeInstanceOf(InvalidTaskIdError);
  });

  it("list() returns [] when tasksDir doesn't exist yet", async () => {
    await rm(tasksDir, { recursive: true, force: true });
    const { m } = await makeManager();
    expect(await m.list()).toEqual([]);
  });

  it("list() returns dispatched tasks newest-first", async () => {
    const rt = new StubRuntime();
    let nowMs = Date.parse("2026-05-08T01:00:00.000Z");
    const { m } = await makeManager({
      runtime: rt,
      now: () => new Date(nowMs),
      // Each dispatch uses 2 random buffers (one per id-gen attempt). We
      // step the seed enough that distinct dispatches land on distinct ids.
      randomBytes: seqRandom(1),
    });
    const t1 = await m.dispatch(dispatchOf({ brief: "first" }));
    nowMs += 60_000;
    const t2 = await m.dispatch(dispatchOf({ brief: "second" }));
    nowMs += 60_000;
    const t3 = await m.dispatch(dispatchOf({ brief: "third" }));

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
    const { m, orm } = await makeManager({ runtime: new StubRuntime(), logger: r.logger });
    await m.dispatch(dispatchOf()); // good row through public API

    // Forge a row whose metadata is invalid JSON; rowToTask throws
    // CorruptedTaskError → repo.list catches, drops, warns.
    orm.sqlite
      .prepare(
        "INSERT INTO tasks (id, agent, runtime, origin, status, brief, details, created_at, started_at, ended_at, success, failure, cancellation, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "20260101-deadbeef",
        "demo",
        "copilot",
        "standalone",
        "running",
        "i",
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        null,
        null,
        null,
        null,
        "not-valid-json{",
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
    const { m, orm } = await makeManager({ runtime: new StubRuntime() });
    const id = "20260101-deadbeef";
    orm.sqlite
      .prepare(
        "INSERT INTO tasks (id, agent, runtime, origin, status, brief, details, created_at, started_at, ended_at, success, failure, cancellation, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        "demo",
        "copilot",
        "standalone",
        "running",
        "i",
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        null,
        null,
        null,
        null,
        "not-valid-json{",
      );
    await expect(m.get(id)).rejects.toBeInstanceOf(CorruptedTaskError);
  });

  it("list() ignores directories whose name doesn't match the task id pattern", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });
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
      const { m } = await makeManager({
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
      const { m } = await makeManager({
        registry: reg,
        runtime: copilot,
      });
      await m.dispatch(dispatchOf({ runtime: "copilot" }));
      await m.dispatch(dispatchOf({ runtime: "gemini" }));

      const onlyGemini = await m.list({ runtime: "gemini" });
      expect(onlyGemini).toHaveLength(1);
      expect(readTaskRuntimeMetadata(onlyGemini[0]).runtime).toBe("gemini");
    });

    it("filters by createdSince (lexicographic on ISO 8601)", async () => {
      const rt = new StubRuntime();
      let nowMs = Date.parse("2026-05-08T01:00:00.000Z");
      const { m } = await makeManager({
        runtime: rt,
        now: () => new Date(nowMs),
        randomBytes: seqRandom(1),
      });
      await m.dispatch(dispatchOf({ brief: "old" }));
      nowMs += 60_000;
      const cutoff = new Date(nowMs).toISOString();
      nowMs += 60_000;
      await m.dispatch(dispatchOf({ brief: "new" }));

      const recent = await m.list({ createdSince: cutoff });
      expect(recent).toHaveLength(1);
      expect(recent[0].brief).toBe("new");
    });

    it("filters by status set (running|success|failure|cancelled|not_started)", async () => {
      const rt = new StubRuntime();
      const { m } = await makeManager({ runtime: rt });
      const a = await m.dispatch(dispatchOf({ brief: "a" }));
      void rt.handles[0].exit({ code: 0, signal: null });
      await awaitTerminal(m, a.id);
      await m.dispatch(dispatchOf({ brief: "b" })); // stays running

      const onlyRunning = await m.list({ statuses: ["running"] });
      expect(onlyRunning).toHaveLength(1);
      expect(onlyRunning[0].brief).toBe("b");

      const onlySuccess = await m.list({ statuses: ["succeeded"] });
      expect(onlySuccess).toHaveLength(1);
      expect(onlySuccess[0].brief).toBe("a");

      const both = await m.list({ statuses: ["running", "succeeded"] });
      expect(both).toHaveLength(2);
    });

    it("combines multiple filters with AND semantics", async () => {
      const rt = new StubRuntime();
      const { m } = await makeManager({
        runtime: rt,
        catalog: stubCatalog({
          agents: { writer: fakeAgentResolve("writer"), reviewer: fakeAgentResolve("reviewer") },
        }),
      });
      await m.dispatch(dispatchOf({ agent: "writer", brief: "w1" }));
      await m.dispatch(dispatchOf({ agent: "reviewer", brief: "r1" }));
      const target = await m.dispatch(dispatchOf({ agent: "writer", brief: "w2" }));
      void rt.handles[2].exit({ code: 0, signal: null });
      await awaitTerminal(m, target.id);

      const writersDone = await m.list({ agent: "writer", statuses: ["succeeded"] });
      expect(writersDone).toHaveLength(1);
      expect(writersDone[0].brief).toBe("w2");
    });
  });
});

describe("delete (terminal-only post ADR-001)", () => {
  it("default delete removes metadata; workdir preserved", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });
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
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);

    await m.delete(t.id, { purge: true });
    await m._drainPendingPurgesForTest();

    expect(await safeStat(path.join(tasksDir, t.id))).toBeNull();
  });

  it("throws TaskNotFoundError for an unknown id", async () => {
    const { m } = await makeManager();
    await expect(m.delete("20260101-deadbeef")).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it("purge: true also returns TaskNotFoundError when the row doesn't exist", async () => {
    // ADR-001 removed the stat-based escape hatch — a workdir with no
    // row is no longer wipeable through delete(); sqlite3 CLI is the
    // recovery channel for that case (§3.5).
    const { m } = await makeManager();
    await expect(m.delete("20260101-deadbeef", { purge: true })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });

  // Default mode reads via loadTask which throws CorruptedTaskError;
  // ADR-001 removed the previous purge-tolerance for corrupted rows,
  // so both default AND purge propagate the error now.
  it("propagates CorruptedTaskError (operator sees the corruption)", async () => {
    const { m, orm } = await makeManager({ runtime: new StubRuntime() });
    const id = "20260101-deadbeef";
    orm.sqlite
      .prepare(
        "INSERT INTO tasks (id, agent, runtime, origin, status, brief, details, created_at, started_at, ended_at, success, failure, cancellation, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        "demo",
        "copilot",
        "standalone",
        "running",
        "i",
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        null,
        null,
        null,
        null,
        "not-valid-json{",
      );
    await expect(m.delete(id)).rejects.toBeInstanceOf(CorruptedTaskError);
    await expect(m.delete(id, { purge: true })).rejects.toBeInstanceOf(CorruptedTaskError);
  });
  // Mirrors SessionService.delete({purge:true}): runtime per-task state
  // (e.g. Copilot's <copilotStateDir>/<runtimeSessionId>/) must be cleaned
  // up too, otherwise purge leaks events.jsonl + transcripts forever.
  it("purge: true asks the runtime to wipe its per-task state, with task metadata", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);

    expect(rt.deleteStateCalls).toEqual([]);
    await m.delete(t.id, { purge: true });
    await m._drainPendingPurgesForTest();

    expect(rt.deleteStateCalls).toHaveLength(1);
    expect(rt.deleteStateCalls[0].runtimeSessionId).toBe(rt.handles[0].runtimeSessionId);
  });

  // Default (archive) mode preserves runtime state — only the row is dropped,
  // not the workdir, not the runtime's events.jsonl. This matches the
  // "operators can recover the agent's product after a delete" intent.
  it("default delete does NOT call runtime.deleteState", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);

    await m.delete(t.id);

    expect(rt.deleteStateCalls).toEqual([]);
  });

  // Fire-and-forget contract: delete() returns BEFORE runtime.deleteState
  // resolves. We stall deleteState on a pending promise so the test can
  // observe the gap; if delete() awaited the cleanup, this test would
  // never reach the post-delete assertions.
  it("purge: true returns before runtime.deleteState resolves", async () => {
    const rt = new StubRuntime();
    let releaseDeleteState: () => void = () => {};
    const deleteStateGate = new Promise<void>((resolve) => {
      releaseDeleteState = resolve;
    });
    const origDeleteState = rt.deleteState.bind(rt);
    rt.deleteState = async (rsid: string): Promise<void> => {
      rt.deleteStateCalls.push({ runtimeSessionId: rsid });
      await deleteStateGate;
    };

    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);

    await m.delete(t.id, { purge: true });

    // DB row is gone (synchronous semantic).
    expect(await m.get(t.id)).toBeNull();

    // setImmediate has had a chance to fire; the background job is
    // suspended inside runtime.deleteState. The caller did NOT await it.
    await flushMicrotasks(3);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rt.deleteStateCalls).toHaveLength(1);
    // Workdir still on disk — the rm sits after the deleteState gate.
    expect(await safeStat(path.join(tasksDir, t.id))).not.toBeNull();

    // Releasing the gate lets _drainPendingPurgesForTest() see completion.
    releaseDeleteState();
    await m._drainPendingPurgesForTest();
    expect(await safeStat(path.join(tasksDir, t.id))).toBeNull();
    // Restore so any teardown using the original behavior still works.
    rt.deleteState = origDeleteState;
  });

  // After _drainPendingPurgesForTest both the runtime.deleteState and
  // the workdir rm have completed.
  it("_drainPendingPurgesForTest awaits both runtime.deleteState and workdir rm", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);

    await m.delete(t.id, { purge: true });
    await m._drainPendingPurgesForTest();

    expect(rt.deleteStateCalls).toHaveLength(1);
    expect(await safeStat(path.join(tasksDir, t.id))).toBeNull();
  });

  // Fire-and-forget swallows runtime.deleteState failures. Pre-fix this
  // surfaced to the caller; now it goes to the logger only.
  it("purge: true swallows runtime.deleteState errors and logs warn", async () => {
    const rt = new StubRuntime();
    rt.deleteStateError = new Error("permission denied wiping state dir");
    const r = recorder();
    const { m } = await makeManager({ runtime: rt, logger: r.logger });
    const t = await m.dispatch(dispatchOf());
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);

    await expect(m.delete(t.id, { purge: true })).resolves.toBeUndefined();
    await m._drainPendingPurgesForTest();

    // Row gone (sync semantic).
    expect(await m.get(t.id)).toBeNull();
    // Workdir still got rm'd because the runtime failure doesn't abort
    // the background job anymore.
    expect(await safeStat(path.join(tasksDir, t.id))).toBeNull();

    const warn = r.calls.find(
      (c) => typeof c.msg === "string" && c.msg.includes("runtime.deleteState failed"),
    );
    expect(warn).toBeDefined();
    const meta = warn?.meta as { taskId?: string; runtimeSessionId?: string; err?: unknown };
    expect(meta?.taskId).toBe(t.id);
    expect(meta?.runtimeSessionId).toBe(rt.handles[0].runtimeSessionId);
    expect(meta?.err).toBeInstanceOf(Error);
  });

  // Fire-and-forget swallows workdir rm failures.
  it("purge: true swallows workdir rm errors and logs warn", async () => {
    const rt = new StubRuntime();
    const r = recorder();
    const { m } = await makeManager({ runtime: rt, logger: r.logger });
    const t = await m.dispatch(dispatchOf());
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);

    const rmError = new Error("simulated EBUSY on workdir rm");
    rmFail.enabled = true;
    rmFail.error = rmError;

    await expect(m.delete(t.id, { purge: true })).resolves.toBeUndefined();
    await m._drainPendingPurgesForTest();

    const warn = r.calls.find(
      (c) => typeof c.msg === "string" && c.msg.includes("workdir rm failed"),
    );
    expect(warn).toBeDefined();
    const meta = warn?.meta as { taskId?: string; workdir?: string; err?: unknown };
    expect(meta?.taskId).toBe(t.id);
    expect(typeof meta?.workdir).toBe("string");
    expect(meta?.err).toBe(rmError);
  });

  // Default mode never schedules a background purge — the drain is a
  // no-op and runtime.deleteState is never called.
  it("default delete does NOT schedule a background purge", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);

    await m.delete(t.id);
    // Nothing pending — drain returns immediately.
    await m._drainPendingPurgesForTest();
    expect(rt.deleteStateCalls).toEqual([]);
  });
});

describe("shutdown", () => {
  it("kills all live tasks and marks them failure with kind='shutdown'", async () => {
    const rt = new StubRuntime();
    rt.autoExitOnKill = true;
    const { m } = await makeManager({ runtime: rt });

    const t1 = await m.dispatch(dispatchOf({ brief: "a" }));
    const t2 = await m.dispatch(dispatchOf({ brief: "b" }));

    await m.shutdown();

    const a1 = await m.get(t1.id);
    const a2 = await m.get(t2.id);
    expect(a1?.status).toBe("failed");
    expect(a2?.status).toBe("failed");
    expect(a1?.failure?.kind).toBe("shutdown");
    expect(a2?.failure?.kind).toBe("shutdown");
    expect(a1?.failure?.message).toBe("server shutdown");
    expect(a2?.failure?.message).toBe("server shutdown");
  });

  it("refuses new dispatch after shutdown is called", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });
    await m.shutdown();
    await expect(m.dispatch(dispatchOf())).rejects.toThrow(/shutting down/);
  });

  it("is idempotent — calling shutdown twice doesn't throw", async () => {
    const { m } = await makeManager();
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
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());

    // Trigger the natural success exit BEFORE invoking shutdown. The
    // exit watcher's read of killedByUs happens AT exit time and sees
    // false, so the task records success regardless of what shutdown()
    // does to other live tasks.
    void rt.handles[0].exit({ code: 0, signal: null });
    const after = await awaitTerminal(m, t.id);
    expect(after.status).toBe("succeeded");

    // Now shutdown is a no-op for this task (already terminal, dropped
    // from this.live by the watcher).
    await m.shutdown();
    const final = await m.get(t.id);
    expect(final?.status).toBe("succeeded");
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
    const { m } = await makeManager({ runtime: rt });
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
    // Under the SDK model the CLI subprocess is a child of the emploke
    // server, so any `running` task at boot is genuinely orphaned —
    // no per-process liveness probe is needed.
    const id = "20260508-deadbeef";
    const workdir = path.join(tasksDir, id);
    await mkdir(workdir, { recursive: true });
    const orphan = TaskEntity.fromStored({
      id,
      agent: "demo",
      brief: "do something",
      origin: "standalone",
      status: "running",
      metadata: { runtime: "copilot" },
      createdAt: "2026-05-08T01:00:00.000Z",
      startedAt: "2026-05-08T01:00:01.000Z",
    });
    const { m, repo } = await makeManager();
    await repo.save(orphan);

    await m.recoverOrphaned();

    const after = await m.get(id);
    expect(after?.status).toBe("failed");
    expect(after?.failure?.kind).toBe("orphan");
    expect(after?.failure?.message).toMatch(/orphaned/);
  });

  it("leaves terminal tasks unchanged", async () => {
    const id = "20260508-cafef00d";
    const workdir = path.join(tasksDir, id);
    await mkdir(workdir, { recursive: true });
    const done = TaskEntity.fromStored({
      id,
      agent: "demo",
      brief: "did it",
      origin: "standalone",
      status: "succeeded",
      metadata: {},
      createdAt: "2026-05-08T01:00:00.000Z",
      startedAt: "2026-05-08T01:00:01.000Z",
      endedAt: "2026-05-08T01:00:02.000Z",
      success: { output: "ok" },
    });
    const { m, repo } = await makeManager();
    await repo.save(done);

    await m.recoverOrphaned();

    const after = await m.get(id);
    expect(after?.status).toBe("succeeded");
    expect(after?.success?.output).toBe("ok");
  });

  it("is a no-op when the tasks directory doesn't exist", async () => {
    await rm(tasksDir, { recursive: true, force: true });
    const { m } = await makeManager();
    await expect(m.recoverOrphaned()).resolves.toBeUndefined();
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
async function awaitTerminal(m: TaskService, id: string): Promise<TaskEntity> {
  let last: TaskEntity | null = null;
  await waitFor(async () => {
    last = await m.get(id);
    if (last === null) return false;
    return last.status !== "running" && last.status !== "not_started";
  });
  if (last === null) throw new Error(`awaitTerminal: task ${id} not found`);
  return last;
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
  it.skip("threads EMPLOKE_* (env layering moved to runtime; needs runtime-level test)", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({
      runtime: rt,
      workspaceId: "ws-uuid-alpha",
      subprocessEnv: { EMPLOKE_SERVER: "http://127.0.0.1:8787" },
    });
    const t = await m.dispatch(dispatchOf({ agent: "demo", brief: "go" }));

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

  it.skip("omits EMPLOKE_WORKSPACE (workspaceId now required)", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });
    await m.dispatch(dispatchOf({ agent: "demo", brief: "go" }));

    const env = rt.dispatchCalls[0].subprocessEnv;
    expect(env).toBeDefined();
    expect("EMPLOKE_WORKSPACE" in (env ?? {})).toBe(false);
    // Per-task fields are still set even without a workspaceId.
    expect(env?.EMPLOKE_WORKSPACE_DIR).toBe(tasksDir);
    expect(env?.EMPLOKE_WORK_ID).toMatch(/^\d{8}-[0-9a-f]{8}$/);
  });

  it("two concurrent dispatches on the same manager get disjoint EMPLOKE_WORK_IDs (no shared bag)", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({
      runtime: rt,
      workspaceId: "ws-uuid-1",
      randomBytes: seqRandom(),
    });
    const [t1, t2] = await Promise.all([
      m.dispatch(dispatchOf({ agent: "demo", brief: "a" })),
      m.dispatch(dispatchOf({ agent: "demo", brief: "b" })),
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

  it.skip("two managers isolated env bags (env layering moved to runtime)", async () => {
    // Same shared base (mimics what WorkspaceContextRegistry does in
    // production: one frozen base passed by reference into every
    // per-workspace manager). Concurrency-safety means workspace A's
    // dispatch and workspace B's dispatch must NEVER cross-contaminate
    // — even though they share the base bag by reference.
    const sharedBase = Object.freeze({ EMPLOKE_SERVER: "http://127.0.0.1:8787" });

    const rtA = new StubRuntime();
    const { m: managerA } = await makeManager({
      runtime: rtA,
      workspaceId: "ws-A",
      subprocessEnv: sharedBase,
    });

    const rtB = new StubRuntime();
    const { m: managerB } = await makeManager({
      runtime: rtB,
      workspaceId: "ws-B",
      subprocessEnv: sharedBase,
    });

    await Promise.all([
      managerA.dispatch(dispatchOf({ agent: "demo", brief: "x" })),
      managerB.dispatch(dispatchOf({ agent: "demo", brief: "y" })),
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

  it.skip("layered fields override base (env layering moved to runtime)", async () => {
    // Pathological config: base accidentally has a stale workspace
    // pinned. The manager's own workspaceId must still win — base is
    // a default, not a hard pin.
    const rt = new StubRuntime();
    const { m } = await makeManager({
      runtime: rt,
      workspaceId: "real-workspace",
      subprocessEnv: {
        EMPLOKE_WORKSPACE: "stale-from-base",
        EMPLOKE_SERVER: "http://127.0.0.1:8787",
      },
    });
    await m.dispatch(dispatchOf({ agent: "demo", brief: "x" }));
    const env = rt.dispatchCalls[0].subprocessEnv;
    expect(env?.EMPLOKE_WORKSPACE).toBe("real-workspace");
    expect(env?.EMPLOKE_SERVER).toBe("http://127.0.0.1:8787");
  });
});

// ───── runtime metadata enrichment (post-#111 cleanup) ─────

describe("enrichWithRuntimeMetadata — title / userTitled removed for tasks", () => {
  // Post-#111: Copilot's auto-generated session `name` reflects the
  // framing prompt rather than the user's task, so deriving a task
  // headline from runtime metadata is actively misleading. The
  // first-class `TaskEntity.brief` field is now the only source of truth
  // for the displayed label. The runtime layer's `readMetadata`
  // surface is preserved (Session still uses it for `preview` via
  // `readCopilotWorkspaceYaml`), but the task manager's enrichment
  // path no longer folds `title` / `userTitled` into the metadata bag.
  it("does NOT inject metadata.title even when the runtime supplies one", async () => {
    const rt = new StubRuntime();
    rt.readMetadataResponse = {
      title: "irrelevant runtime-derived title",
      userTitled: false,
      lastActiveAt: "2026-05-08T01:30:00.000Z",
    };
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf({ brief: "Real brief" }));

    const refreshed = await m.get(t.id);
    expect(refreshed?.brief).toBe("Real brief");
    expect("title" in (refreshed?.metadata ?? {})).toBe(false);
    expect("userTitled" in (refreshed?.metadata ?? {})).toBe(false);
  });

  it("does NOT inject metadata.userTitled even when the runtime reports user_named=true", async () => {
    const rt = new StubRuntime();
    rt.readMetadataResponse = {
      title: "user-renamed",
      userTitled: true,
      lastActiveAt: "2026-05-08T01:30:00.000Z",
    };
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf({ brief: "Authoritative brief" }));

    const refreshed = await m.get(t.id);
    expect(refreshed?.brief).toBe("Authoritative brief");
    expect("title" in (refreshed?.metadata ?? {})).toBe(false);
    expect("userTitled" in (refreshed?.metadata ?? {})).toBe(false);
  });

  it("DOES still inject metadata.lastActiveAtRuntime so dashboards can show recency", async () => {
    const rt = new StubRuntime();
    rt.readMetadataResponse = {
      title: null,
      userTitled: false,
      lastActiveAt: "2026-05-08T01:30:00.000Z",
    };
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf({ brief: "Brief" }));

    const refreshed = await m.get(t.id);
    expect(refreshed?.metadata.lastActiveAtRuntime).toBe("2026-05-08T01:30:00.000Z");
  });

  it("leaves metadata untouched when runtime returns null lastActiveAt", async () => {
    const rt = new StubRuntime();
    rt.readMetadataResponse = {
      title: null,
      userTitled: false,
      lastActiveAt: null,
    };
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf({ brief: "Brief" }));

    const refreshed = await m.get(t.id);
    expect("lastActiveAtRuntime" in (refreshed?.metadata ?? {})).toBe(false);
  });
});

// ───── issue #181 — TaskSuccess output + artifacts at terminal time ────

describe("applyTerminal succeeded — output + artifacts capture (#181)", () => {
  // Helper: build an ActivityResult with N items, the last `assistant`
  // text controllable. Mirrors the runtime contract.
  const mkActivity = (items: import("@emploke/runtime").ActivityItem[]) => ({
    activity: items,
    result: null,
    totalItems: items.length,
  });

  it("captures the last assistant utterance + lists workdir/artifact/ files", async () => {
    const rt = new StubRuntime();
    rt.readActivityResponse = mkActivity([
      { kind: "user", seq: 0, timestamp: "2026-05-08T00:00:00Z", text: "do it" },
      { kind: "assistant", seq: 1, timestamp: "2026-05-08T00:00:01Z", text: "hello world" },
    ]);
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());

    // Drop two artifact files into the workdir before exit fires.
    const meta = readTaskRuntimeMetadata(t);
    const artDir = path.join(meta.workdir as string, TASK_ARTIFACT_SUBDIR);
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.writeFile(path.join(artDir, "a.txt"), "alpha"),
        fs.writeFile(path.join(artDir, "b.html"), "<html/>"),
      ]),
    );

    void rt.handles[0].exit({ code: 0, signal: null });
    const after = await awaitTerminal(m, t.id);
    expect(after.status).toBe("succeeded");
    expect(after.success?.output).toBe("hello world");
    expect(after.success?.artifacts).toEqual([
      path.join(artDir, "a.txt"),
      path.join(artDir, "b.html"),
    ]);
  });

  it("output=null when activity has no assistant item (only user/tool)", async () => {
    const rt = new StubRuntime();
    rt.readActivityResponse = mkActivity([
      { kind: "user", seq: 0, timestamp: "2026-05-08T00:00:00Z", text: "do it" },
    ]);
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());

    const meta = readTaskRuntimeMetadata(t);
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(path.join(meta.workdir as string, TASK_ARTIFACT_SUBDIR, "x.txt"), "x"),
    );

    void rt.handles[0].exit({ code: 0, signal: null });
    const after = await awaitTerminal(m, t.id);
    expect(after.success?.output).toBeNull();
    expect(after.success?.artifacts).toHaveLength(1);
  });

  it("output=null when runtime.getLastAgentActivity returns null", async () => {
    const rt = new StubRuntime();
    rt.getLastAgentActivityResponse = null;
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());

    void rt.handles[0].exit({ code: 0, signal: null });
    const after = await awaitTerminal(m, t.id);
    expect(after.status).toBe("succeeded");
    // Distinct from "" (which would mean "the agent explicitly emitted
    // an empty turn") and undefined (which would mean "the field was
    // never written"). Null is the canonical "no summary".
    expect(after.success?.output).toBeNull();
    expect(rt.getLastAgentActivityCallCount).toBeGreaterThan(0);
  });

  it("getLastAgentActivity throws → succeeded transition still completes, warn logged, output=null", async () => {
    const rt = new StubRuntime();
    rt.getLastAgentActivityError = new Error("runtime activity log corrupt");
    const r = recorder();
    const { m } = await makeManager({ runtime: rt, logger: r.logger });
    const t = await m.dispatch(dispatchOf());

    void rt.handles[0].exit({ code: 0, signal: null });
    const after = await awaitTerminal(m, t.id);
    expect(after.status).toBe("succeeded");
    expect(after.success?.output).toBeNull();
    const warn = r.calls.find((c) => c.msg.includes("getLastAgentActivity failed"));
    expect(warn).toBeDefined();
  });

  it("no artifact/ dir (ENOENT) → artifacts=[], no error", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    // Remove the artifact/ dir the dispatch path created so we hit ENOENT.
    const meta = readTaskRuntimeMetadata(t);
    await rm(path.join(meta.workdir as string, TASK_ARTIFACT_SUBDIR), {
      recursive: true,
      force: true,
    });

    void rt.handles[0].exit({ code: 0, signal: null });
    const after = await awaitTerminal(m, t.id);
    expect(after.status).toBe("succeeded");
    expect(after.success?.artifacts).toEqual([]);
  });

  it("output is capped from the tail when assistant text exceeds the cap (head is preserved — regression for iter-2 B2)", async () => {
    const rt = new StubRuntime();
    // Build a long message whose head is the most informative part —
    // mirroring real summaries like "Done. PR opened at <url>". The
    // earlier `slice(-500)` bug would drop this head. The fix's head
    // cap must preserve it.
    const HEAD = "Done. PR opened at **https://github.com/LangSensei/emploke/pull/186**.\n";
    const long = HEAD + "X".repeat(10_000);
    rt.readActivityResponse = mkActivity([
      { kind: "assistant", seq: 0, timestamp: "2026-05-08T00:00:00Z", text: long },
    ]);
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());

    void rt.handles[0].exit({ code: 0, signal: null });
    const after = await awaitTerminal(m, t.id);
    const out = after.success?.output ?? "";
    // 1. Head is intact (the original bug's fingerprint).
    expect(out.startsWith(HEAD)).toBe(true);
    // 2. Output is bounded (cap defined by TASK_OUTPUT_MAX_CHARS = 8000).
    expect(out.length).toBe(8000);
    // 3. Truncation removed only from the tail.
    expect(out).toBe(long.slice(0, 8000));
  });

  it("short outputs (≤ cap) pass through verbatim", async () => {
    const rt = new StubRuntime();
    const msg = "Done. PR opened at **https://github.com/x/y/pull/1**.\n\nSummary: ok.";
    rt.readActivityResponse = mkActivity([
      { kind: "assistant", seq: 0, timestamp: "2026-05-08T00:00:00Z", text: msg },
    ]);
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());

    void rt.handles[0].exit({ code: 0, signal: null });
    const after = await awaitTerminal(m, t.id);
    expect(after.success?.output).toBe(msg);
  });
});

// ───── issue #180 / ADR-002 — list / get enrichment scoping ────────────

describe("list() does NOT call runtime.readMetadata (ADR-002)", () => {
  it("returns rows verbatim even when readMetadata would throw", async () => {
    const rt = new StubRuntime();
    rt.readMetadataResponse = {
      title: null,
      userTitled: false,
      lastActiveAt: "2026-05-08T01:30:00.000Z",
    };
    const { m } = await makeManager({ runtime: rt });
    for (let i = 0; i < 3; i++) {
      await m.dispatch(dispatchOf({ brief: `Task ${i}` }));
    }
    rt.readMetadataCallCount = 0;
    const rows = await m.list();
    expect(rows).toHaveLength(3);
    expect(rt.readMetadataCallCount).toBe(0);
    for (const r of rows) {
      expect("lastActiveAtRuntime" in r.metadata).toBe(false);
    }
  });
});

describe("get() enrichment is scoped to running tasks (ADR-002)", () => {
  it("running task → enrich (readMetadata is called)", async () => {
    const rt = new StubRuntime();
    rt.readMetadataResponse = {
      title: null,
      userTitled: false,
      lastActiveAt: "2026-05-08T01:30:00.000Z",
    };
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    rt.readMetadataCallCount = 0;
    const refreshed = await m.get(t.id);
    expect(refreshed?.status).toBe("running");
    expect(rt.readMetadataCallCount).toBe(1);
    expect(refreshed?.metadata.lastActiveAtRuntime).toBe("2026-05-08T01:30:00.000Z");
  });

  it("terminal task → no enrichment (readMetadata is NOT called)", async () => {
    const rt = new StubRuntime();
    rt.readMetadataResponse = {
      title: null,
      userTitled: false,
      lastActiveAt: "2026-05-08T01:30:00.000Z",
    };
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);
    rt.readMetadataCallCount = 0;
    const refreshed = await m.get(t.id);
    expect(refreshed?.status).toBe("succeeded");
    expect(rt.readMetadataCallCount).toBe(0);
    expect("lastActiveAtRuntime" in (refreshed?.metadata ?? {})).toBe(false);
  });
});

describe("background purges run serially (ADR-002)", () => {
  it("N concurrent deletes pin at most one runtime.deleteState in flight", async () => {
    const rt = new StubRuntime();
    // Track in-flight deleteState invocations to assert serial execution.
    let inFlight = 0;
    let maxInFlight = 0;
    const origDelete = rt.deleteState.bind(rt);
    rt.deleteState = async (rsid: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        await origDelete(rsid);
      } finally {
        inFlight--;
      }
    };

    const { m } = await makeManager({ runtime: rt });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const t = await m.dispatch(dispatchOf({ brief: `Task ${i}` }));
      void rt.handles[i].exit({ code: 0, signal: null });
      await awaitTerminal(m, t.id);
      ids.push(t.id);
    }
    // Schedule purges back-to-back. The chained queue serialises them.
    await Promise.all(ids.map((id) => m.delete(id, { purge: true })));
    await m._drainPendingPurgesForTest();

    expect(rt.deleteStateCalls).toHaveLength(4);
    expect(maxInFlight).toBe(1);
  });
});

// ───── issue #181 — TaskService.resolveArtifactPath ────────────────────

describe("resolveArtifactPath (#181)", () => {
  it("running task → null", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    expect(await m.resolveArtifactPath(t.id, "anything")).toBeNull();
  });

  it("terminal task with matching artifact → returns absolute path", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    const meta = readTaskRuntimeMetadata(t);
    const artDir = path.join(meta.workdir as string, TASK_ARTIFACT_SUBDIR);
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(path.join(artDir, "report.html"), "<h1/>"),
    );
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);

    const resolved = await m.resolveArtifactPath(t.id, "report.html");
    expect(resolved).toBe(path.join(artDir, "report.html"));
  });

  it("terminal task missing artifact in whitelist → null (whitelist enforced)", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);
    expect(await m.resolveArtifactPath(t.id, "not-listed.txt")).toBeNull();
  });

  it("rejects '..' name even if a literal '..' somehow made the whitelist", async () => {
    const rt = new StubRuntime();
    const { m } = await makeManager({ runtime: rt });
    const t = await m.dispatch(dispatchOf());
    void rt.handles[0].exit({ code: 0, signal: null });
    await awaitTerminal(m, t.id);
    expect(await m.resolveArtifactPath(t.id, "..")).toBeNull();
    expect(await m.resolveArtifactPath(t.id, ".")).toBeNull();
    expect(await m.resolveArtifactPath(t.id, "")).toBeNull();
  });
});

// ───── deleteForSchedule (cascade-delete from schedule.delete) ─────────────────
//
// ScheduleService.delete calls this to purge every TERMINAL task a
// schedule produced when the user removes the trigger. Workdirs are
// enqueued on the same serialised purgeQueue used by single-task
// delete(id, { purge: true }), so we exercise drain semantics with
// the test seam.

describe("TaskService.deleteForSchedule (cascade-delete)", () => {
  async function seedFiredTask(
    m: TaskService,
    repo: TaskRepository,
    args: { scheduleId: string; status: "succeeded" | "failed" | "cancelled" },
  ): Promise<TaskEntity> {
    // Dispatch a real task so the workdir actually exists, then overwrite
    // its row with the desired terminal status + schedule metadata. Going
    // through dispatch is necessary for the workdir to exist (the purge
    // enqueues a recursive remove against it).
    const t = await m.dispatch(dispatchOf());
    const ended = "2026-05-08T02:00:00.000Z";
    const base = {
      ...t.toJSON(),
      origin: "schedule" as const,
      status: args.status,
      metadata: { ...t.metadata, scheduleId: args.scheduleId },
      endedAt: ended,
    };
    const overlay: Record<string, unknown> = {};
    if (args.status === "succeeded") overlay.success = { output: "ok" };
    else if (args.status === "failed") overlay.failure = { kind: "internal", message: "boom" };
    else overlay.cancellation = { kind: "user", message: "stop" };
    const reseeded = TaskEntity.fromStored({ ...base, ...overlay } as never);
    await repo.save(reseeded);
    return reseeded;
  }

  it("returns { deletedCount: 0 } when no historical tasks match", async () => {
    const { m } = await makeManager();
    expect(await m.deleteForSchedule("sched-empty")).toEqual({ deletedCount: 0 });
  });

  it("removes every terminal task for the schedule and enqueues workdir purge for each", async () => {
    const rt = new StubRuntime();
    const { m, repo } = await makeManager({ runtime: rt });
    const a = await seedFiredTask(m, repo, { scheduleId: "sched-1", status: "succeeded" });
    const b = await seedFiredTask(m, repo, { scheduleId: "sched-1", status: "failed" });
    const c = await seedFiredTask(m, repo, { scheduleId: "sched-other", status: "succeeded" });

    const result = await m.deleteForSchedule("sched-1");
    expect(result).toEqual({ deletedCount: 2 });

    // DB rows for sched-1 are gone; sched-other survives.
    expect(await m.get(a.id)).toBeNull();
    expect(await m.get(b.id)).toBeNull();
    expect(await m.get(c.id)).not.toBeNull();

    // Workdirs are removed in the background.
    await m._drainPendingPurgesForTest();
    expect(await safeStat(path.join(tasksDir, a.id))).toBeNull();
    expect(await safeStat(path.join(tasksDir, b.id))).toBeNull();
    expect(await safeStat(path.join(tasksDir, c.id))).not.toBeNull();
  });

  it("does NOT delete running tasks even if their scheduleId matches (terminal-only filter)", async () => {
    const rt = new StubRuntime();
    const { m, repo } = await makeManager({ runtime: rt });
    const terminal = await seedFiredTask(m, repo, {
      scheduleId: "sched-1",
      status: "succeeded",
    });
    // A still-running task for the same schedule. Real dispatch leaves
    // it as running until the runtime handle exits.
    const live = await m.dispatch(dispatchOf());
    // Backdate it to look schedule-owned without exiting it.
    await repo.save(
      TaskEntity.fromStored({
        ...live.toJSON(),
        origin: "schedule",
        metadata: { ...live.metadata, scheduleId: "sched-1" },
      } as never),
    );

    const result = await m.deleteForSchedule("sched-1");
    expect(result).toEqual({ deletedCount: 1 });

    expect(await m.get(terminal.id)).toBeNull();
    expect(await m.get(live.id)).not.toBeNull();

    // Drain so the test fixture's afterEach doesn't see leaked timers.
    const handle = rt.handles[rt.handles.length - 1];
    void handle.exit({ code: 0, signal: null });
    await awaitTerminal(m, live.id);
  });
});
