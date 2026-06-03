import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentContentSource, LaunchCommand, ResolvedAgent, Runtime } from "@emploke/runtime";
import {
  RuntimeProvisionFailed,
  RuntimeRegistry,
  RuntimeStateDeletionFailed,
  UnknownRuntimeError,
} from "@emploke/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentNotFoundError,
  AgentResolutionFailedError,
  type AgentResolverPort,
  InvalidSessionIdError,
  SessionNotFoundError,
  SessionRepository,
  SessionService,
  type SessionServiceConfig,
} from "../src/index.js";
import { openTestSessionDb } from "../src/testing.js";

// ───── helpers ──────────────────────────────────────────────

let sessionsDir: string;
let scratch: string;

/**
 * Per-test ORMs that the buildManager helper hands out. Tracked so
 * afterEach can close them.
 */
type DbHandle = ReturnType<typeof openTestSessionDb>;
let openHandles: DbHandle[] = [];

function makeDb(): DbHandle {
  const handle = openTestSessionDb();
  openHandles.push(handle);
  return handle;
}

/**
 * Construct a `SessionService` with a fresh `:memory:` Drizzle db
 * injected and a default `contentSource` stub. Tests that need to
 * inspect the persisted state can override `opts.db` with their own;
 * tests that exercise the content-source path can override
 * `opts.contentSource`.
 */
async function buildManager(
  opts: Omit<SessionServiceConfig, "db" | "contentSource"> &
    Partial<Pick<SessionServiceConfig, "db" | "contentSource">>,
): Promise<SessionService> {
  const contentSource = opts.contentSource ?? stubContentSource();
  if (opts.db !== undefined) {
    return new SessionService({ ...opts, contentSource } as SessionServiceConfig);
  }
  const orm = makeDb();
  return new SessionService({ ...opts, contentSource, db: orm.db });
}

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-sessions-scratch-"));
  // sessionsDir is `<scratch>/sessions` (computed by SessionService internally
  // from workspaceDir). Tests reference it for assertions on session workdirs.
  sessionsDir = path.join(scratch, "sessions");
  await mkdir(sessionsDir, { recursive: true });
});
afterEach(async () => {
  for (const o of openHandles.splice(0)) {
    try {
      o.close();
    } catch {
      // already closed
    }
  }
  openHandles = [];
  await rm(sessionsDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

interface StubResolverOpts {
  agents?: Record<string, ResolvedAgent>;
  /** Forces `resolveAgent(...)` to throw — used to test 500 mapping. */
  resolveError?: Error;
}

function stubAgentResolver(opts: StubResolverOpts = {}): AgentResolverPort {
  const agents = opts.agents ?? {};
  return {
    async resolveAgent(name: string): Promise<ResolvedAgent> {
      if (opts.resolveError) throw opts.resolveError;
      const a = agents[name];
      if (!a) throw new Error(`agent not found in catalog: "${name}"`);
      return a;
    },
    // Mirrors catalog.getAgentEntry: returns null for unknown agents.
    // Catalog's real behaviour never throws AgentNotFoundError from
    // this path.
    async getAgentEntry(name: string) {
      if (!(name in agents)) return null;
      return { status: "ready" as const };
    },
  };
}

/**
 * Minimal `AgentContentSource` stub. The session tests' stub runtime
 * ignores the content source (its `provision` writes a fixed
 * AGENTS.md and never touches it), so the methods just need to
 * satisfy the type.
 */
function stubContentSource(): AgentContentSource {
  return {
    async resolveAgent(_name: string): Promise<ResolvedAgent> {
      return { agent: { fqn: "stub" }, skills: [], mcps: [] };
    },
    async *agentEntries(_fqn: string) {
      // no entries
    },
    async *skillEntries(_fqn: string) {
      // no entries
    },
    async getMcpRuntimeConfig(_fqn: string) {
      return {};
    },
  };
}

const fakeAgentResolve = (name: string): ResolvedAgent => ({
  agent: { fqn: `public/${name}` },
  skills: [],
  mcps: [],
});

/**
 * A configurable in-memory Runtime that mimics the contract without touching
 * any real CLI. Defaults: provision writes a minimal AGENTS.md so
 * readAgentName() finds the right name; readMetadata returns null (no activity).
 */
class StubRuntime implements Runtime {
  readonly kind: string;
  provisionCalls: { workdir: string; agent: ResolvedAgent }[] = [];
  readMetadataCalls: string[] = [];
  deleteStateCalls: string[] = [];
  buildLaunchCalls: {
    runtimeSessionId: string | null;
    workdir: string;
    workspaceDir: string;
  }[] = [];

  /** Defaults to a stable UUID. Set to `"per-call"` to mint a new uuid per provision. */
  provisionId: string | null = "12345678-1234-1234-1234-1234567890ab";
  /** If set, provision throws this. */
  provisionError: Error | null = null;
  /** If set, readMetadata returns this. */
  readMetadataResult: {
    title: string | null;
    userTitled: boolean;
    lastActiveAt: string | null;
  } | null = null;
  /** Per-session-id overrides for readMetadata. Takes precedence over readMetadataResult. */
  readMetadataResultBy: Map<
    string,
    { title: string | null; userTitled: boolean; lastActiveAt: string | null } | null
  > = new Map();
  /** If set, readMetadata throws this. */
  readMetadataError: Error | null = null;
  /** If set, deleteState throws this. */
  deleteStateError: Error | null = null;
  /** If set, buildInteractiveLaunch returns this on `launch.env`. */
  launchEnv: Readonly<Record<string, string>> | null = null;

  constructor(kind = "copilot") {
    this.kind = kind;
  }

  async provision(
    workdir: string,
    agent: ResolvedAgent,
  ): Promise<{ runtimeSessionId: string | null }> {
    this.provisionCalls.push({ workdir, agent });
    if (this.provisionError) throw this.provisionError;
    await mkdir(workdir, { recursive: true });
    await writeFile(
      path.join(workdir, "AGENTS.md"),
      `---\nname: ${agent.agent.fqn}\n---\n# agent\n`,
      "utf8",
    );
    if (this.provisionId === "per-call") {
      this.provisionCounter += 1;
      const id = `00000000-0000-0000-0000-${String(this.provisionCounter).padStart(12, "0")}`;
      return { runtimeSessionId: id };
    }
    return { runtimeSessionId: this.provisionId };
  }
  private provisionCounter = 0;

  async readMetadata(runtimeSessionId: string) {
    this.readMetadataCalls.push(runtimeSessionId);
    if (this.readMetadataError) throw this.readMetadataError;
    if (this.readMetadataResultBy.has(runtimeSessionId))
      return this.readMetadataResultBy.get(runtimeSessionId) ?? null;
    return this.readMetadataResult;
  }

  async buildInteractiveLaunch(
    runtimeSessionId: string | null,
    workdir: string,
    workspaceDir: string,
  ): Promise<LaunchCommand> {
    this.buildLaunchCalls.push({ runtimeSessionId, workdir, workspaceDir });
    return {
      cmd: "stub",
      args: runtimeSessionId === null ? [] : [`--id=${runtimeSessionId}`],
      cwd: workdir,
      display: `stub ${workdir}`,
      ...(this.launchEnv !== null ? { env: this.launchEnv } : {}),
    };
  }

  async deleteState(runtimeSessionId: string): Promise<void> {
    this.deleteStateCalls.push(runtimeSessionId);
    if (this.deleteStateError) throw this.deleteStateError;
  }
}

function makeRegistry(rt: Runtime): RuntimeRegistry {
  const reg = new RuntimeRegistry();
  reg.register(rt);
  return reg;
}

const fixedNow = (iso: string) => () => new Date(iso);
const seqRandom = () => {
  let i = 0;
  return (n: number) => {
    i++;
    return Buffer.alloc(n, i);
  };
};

const recorder = () => {
  // Matches pino's API shape: (meta, msg). Tight-loop assertion
  // timing rules out a real pino-backed captureLogger here.
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

// ───── construction ──────────────────────────────────────────

describe("SessionService construction", () => {
  it("constructs with catalog + runtimeRegistry + sessionsDir", async () => {
    const m = await buildManager({
      agentResolver: stubAgentResolver(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      workspaceDir: scratch,
    });
    expect(m).toBeDefined();
  });
});

// ───── create ────────────────────────────────────────────────

describe("create()", () => {
  it("provisions, persists state, returns Session shape", async () => {
    const rt = new StubRuntime();
    const orm = makeDb();
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      now: fixedNow("2026-05-08T01:05:00.000Z"),
      randomBytes: seqRandom(),
      db: orm.db,
    });
    const s = await m.create({ agent: "demo" });

    expect(s.agent).toBe("public/demo");
    expect(s.runtime).toBe("copilot");
    expect(s.runtimeSessionId).toBe("12345678-1234-1234-1234-1234567890ab");
    expect(s.lastActiveAt).toBeNull();
    expect(s.preview).toBeNull();
    expect(s.workdir).toBe(path.join(sessionsDir, s.id));
    expect(rt.provisionCalls).toHaveLength(1);

    // Persisted state lives in the SQLite repository row, not in a
    // workdir sidecar. Inspect via the same handle the manager wrote
    // through. `persisted` is a Session entity — compare its
    // POJO projection so the assertion stays shape-only.
    const persisted = await new SessionRepository({ db: orm.db }).findById(s.id);
    expect(persisted).not.toBeNull();
    expect(persisted?.runtime).toBe("copilot");
    expect(persisted?.agent).toBe("public/demo");
    expect(persisted?.createdAt).toBe("2026-05-08T01:05:00.000Z");
    expect(persisted?.runtimeSessionId).toBe("12345678-1234-1234-1234-1234567890ab");
  });

  it("throws AgentNotFoundError for empty agent", async () => {
    const m = await buildManager({
      agentResolver: stubAgentResolver(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      workspaceDir: scratch,
    });
    await expect(m.create({ agent: "" })).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it("throws AgentNotFoundError when getAgentEntry returns null (unknown agent)", async () => {
    // The resolver port reports "unknown" by returning null from
    // getAgentEntry, NOT by throwing a typed not-found error.
    // Destructive validation for the `entry === null` check in
    // session-service.ts's create() flow: deleting it would let the
    // call sail into resolveAgent and surface as a 500
    // AgentResolutionFailedError instead of the user-facing 400.
    const m = await buildManager({
      agentResolver: stubAgentResolver(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      workspaceDir: scratch,
    });
    const err = await m.create({ agent: "missing" }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(AgentNotFoundError);
    expect(err).not.toBeInstanceOf(AgentResolutionFailedError);
    // No `cause` — the resolver simply said "not here", no upstream
    // error to chain.
    expect((err as AgentNotFoundError).cause).toBeUndefined();
  });

  it("wraps a generic resolver error from resolveAgent as AgentResolutionFailedError (NOT AgentNotFoundError)", async () => {
    // A non-typed resolver failure (DB exploded, parser blew up,
    // etc.) is a system fault, not a user error. Any throw from
    // `agentResolver.resolveAgent(...)` is classified as a 500. The
    // not-found path only fires when `getAgentEntry` returns null.
    // Destructive validation for the AgentResolutionFailedError throw
    // site in session-service.ts.
    const foreign = new Error("DB exploded");
    const m = await buildManager({
      agentResolver: stubAgentResolver({
        agents: { demo: fakeAgentResolve("demo") },
        resolveError: foreign,
      }),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      workspaceDir: scratch,
    });
    const err = await m.create({ agent: "demo" }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(AgentResolutionFailedError);
    expect(err).not.toBeInstanceOf(AgentNotFoundError);
    expect((err as AgentResolutionFailedError).agent).toBe("demo");
    expect((err as AgentResolutionFailedError).cause).toBe(foreign);
  });

  it("throws UnknownRuntimeError when runtime kind is not registered", async () => {
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(new StubRuntime("copilot")),
      workspaceDir: scratch,
    });
    await expect(m.create({ agent: "demo", runtime: "gemini" })).rejects.toBeInstanceOf(
      UnknownRuntimeError,
    );
  });

  it("cleans up workdir on provisioner failure", async () => {
    const rt = new StubRuntime();
    rt.provisionError = new RuntimeProvisionFailed("copilot", "/x", new Error("boom"));
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
    });
    await expect(m.create({ agent: "demo" })).rejects.toBeInstanceOf(RuntimeProvisionFailed);
    const fsp = await import("node:fs/promises");
    expect(await fsp.readdir(sessionsDir)).toEqual([]);
  });

  it("supports null runtimeSessionId at create time (gemini-style)", async () => {
    const rt = new StubRuntime();
    rt.provisionId = null;
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    expect(s.runtimeSessionId).toBeNull();
  });
});

// ───── list ──────────────────────────────────────────────────

describe("list()", () => {
  it("returns empty when no rows exist", async () => {
    const m = await buildManager({
      agentResolver: stubAgentResolver(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      workspaceDir: scratch,
    });
    expect(await m.list()).toEqual([]);
  });

  it("ignores stray workdirs that have no corresponding state row", async () => {
    const r = recorder();
    const rt = new StubRuntime();
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      logger: r.logger,
    });
    await m.create({ agent: "demo" });
    // Directories on disk with no SQLite row are invisible to list()
    // — the repository drives the listing, not a directory scan.
    await mkdir(path.join(sessionsDir, "20260101-deadbeef"), { recursive: true });
    await mkdir(path.join(sessionsDir, "not-a-session"), { recursive: true });
    const out = await m.list();
    expect(out).toHaveLength(1);
  });

  it("filters by agent", async () => {
    const m = await buildManager({
      agentResolver: stubAgentResolver({
        agents: { a: fakeAgentResolve("a"), b: fakeAgentResolve("b") },
      }),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      workspaceDir: scratch,
    });
    await m.create({ agent: "a" });
    await m.create({ agent: "b" });
    const onlyA = await m.list({ agent: "public/a" });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]?.agent).toBe("public/a");
  });

  it("filters by createdSince and skips refresh on excluded sessions", async () => {
    const rt = new StubRuntime();
    let nowMs = Date.UTC(2026, 0, 1); // Jan 1 2026
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      now: () => new Date(nowMs),
    });
    // Older session: created Jan 1
    await m.create({ agent: "demo" });
    // Newer session: created Feb 1
    nowMs = Date.UTC(2026, 1, 1);
    await m.create({ agent: "demo" });

    rt.readMetadataCalls.length = 0;
    const onlyNew = await m.list({ createdSince: "2026-01-15T00:00:00.000Z" });
    expect(onlyNew).toHaveLength(1);
    expect(onlyNew[0]?.createdAt).toBe("2026-02-01T00:00:00.000Z");
    // Critical: refresh must NOT have been called for the excluded entry.
    expect(rt.readMetadataCalls).toHaveLength(1);
  });

  it("createdSince combined with agent narrows further", async () => {
    let nowMs = Date.UTC(2026, 0, 1);
    const m = await buildManager({
      agentResolver: stubAgentResolver({
        agents: { a: fakeAgentResolve("a"), b: fakeAgentResolve("b") },
      }),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      workspaceDir: scratch,
      now: () => new Date(nowMs),
    });
    await m.create({ agent: "a" }); // old, agent a
    nowMs = Date.UTC(2026, 1, 1);
    await m.create({ agent: "a" }); // new, agent a
    await m.create({ agent: "b" }); // new, agent b

    const out = await m.list({ agent: "public/a", createdSince: "2026-01-15T00:00:00.000Z" });
    expect(out).toHaveLength(1);
    expect(out[0]?.agent).toBe("public/a");
    expect(out[0]?.createdAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("folds runtime.refresh activity into the record", async () => {
    const rt = new StubRuntime();
    rt.readMetadataResult = {
      lastActiveAt: "2026-05-08T02:00:00.000Z",
      title: "did stuff",
      userTitled: false,
    };
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
    });
    await m.create({ agent: "demo" });
    const [out] = await m.list();
    expect(out?.lastActiveAt).toBe("2026-05-08T02:00:00.000Z");
    expect(out?.preview).toBe("did stuff");
  });

  it("treats null refresh as no activity (lastActiveAt/preview stay null)", async () => {
    const rt = new StubRuntime();
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
    });
    await m.create({ agent: "demo" });
    const [out] = await m.list();
    expect(out?.lastActiveAt).toBeNull();
    expect(out?.preview).toBeNull();
  });

  it("warns and skips sessions whose runtime is not registered", async () => {
    const r = recorder();
    // Create a session under "copilot" but then construct a manager whose
    // registry doesn't know "copilot". Both managers share the same
    // SQLite repository so the runtime-mismatch happens at the manager
    // layer, not at the storage layer.
    const sharedOrm = makeDb();
    const rtA = new StubRuntime();
    const m1 = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rtA),
      workspaceDir: scratch,
      db: sharedOrm.db,
    });
    await m1.create({ agent: "demo" });

    const m2 = await buildManager({
      agentResolver: stubAgentResolver(),
      runtimeRegistry: makeRegistry(new StubRuntime("gemini")),
      workspaceDir: scratch,
      logger: r.logger,
      db: sharedOrm.db,
    });
    expect(await m2.list()).toEqual([]);
    expect(r.calls.some((c) => c.msg.includes("unregistered runtime"))).toBe(true);
  });

  it("sorts never-launched sessions first, then active by lastActiveAt desc", async () => {
    const rt = new StubRuntime();
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
    });
    // Three sessions: a is older but active in 2099, b/c are never launched
    // (lastActiveAt === null). Never-launched sessions ALWAYS go first
    // regardless of createdAt, secondary sort by createdAt desc — so a
    // freshly created session is immediately findable at the top of the
    // list. Order is [c (newer null), b (older null), a (active)].
    rt.readMetadataResult = null;
    const a = await m.create({ agent: "demo" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await m.create({ agent: "demo" });
    await new Promise((r) => setTimeout(r, 5));
    const c = await m.create({ agent: "demo" });
    rt.readMetadataResultBy.set(a.id, {
      lastActiveAt: "2099-01-01T00:00:00.000Z",
      title: null,
      userTitled: false,
    });
    const out = await m.list();
    expect(out.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
  });

  it("activeSince filter drops sessions whose lastActiveAt is null or older than the cutoff", async () => {
    const rt = new StubRuntime();
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
    });
    rt.provisionId = "per-call";
    rt.readMetadataResult = null;
    const old = await m.create({ agent: "demo" });
    const recent = await m.create({ agent: "demo" });
    const _never = await m.create({ agent: "demo" });
    rt.readMetadataResultBy.set(old.runtimeSessionId as string, {
      lastActiveAt: "2026-01-01T00:00:00.000Z",
      title: null,
      userTitled: false,
    });
    rt.readMetadataResultBy.set(recent.runtimeSessionId as string, {
      lastActiveAt: "2099-12-31T00:00:00.000Z",
      title: null,
      userTitled: false,
    });
    // `never` was created at the test's `now()` (typically 2026-01-15);
    // cutoff (2099-01-01) is far in the future so it stays excluded
    // even via the createdAt fallback.
    const cutoff = "2099-01-01T00:00:00.000Z";
    const out = await m.list({ activeSince: cutoff });
    expect(out.map((s) => s.id)).toEqual([recent.id]);
  });

  it("activeSince includes never-launched sessions whose createdAt is within the window", async () => {
    // Regression for "new session not appearing in default 7d filter":
    // a session you just created has lastActiveAt=null until the runtime
    // is queried. The activeSince predicate must fall through to
    // createdAt for such sessions, otherwise the dashboard hides every
    // brand-new session behind its default time filter.
    const rt = new StubRuntime();
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      now: fixedNow("2026-05-08T01:05:00.000Z"),
    });
    rt.readMetadataResult = null;
    const fresh = await m.create({ agent: "demo" }); // createdAt = 2026-05-08
    // Cutoff one day before `now` — a freshly created session must
    // pass even though it has no lastActiveAt.
    const cutoff = "2026-05-07T00:00:00.000Z";
    const out = await m.list({ activeSince: cutoff });
    expect(out.map((s) => s.id)).toEqual([fresh.id]);
  });
});

// ───── get ───────────────────────────────────────────────────

describe("get()", () => {
  it("returns the record by id", async () => {
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    const got = await m.get(s.id);
    expect(got?.id).toBe(s.id);
  });

  it("returns null for valid-but-unknown id", async () => {
    const m = await buildManager({
      agentResolver: stubAgentResolver(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      workspaceDir: scratch,
    });
    expect(await m.get("20260508-deadbeef")).toBeNull();
  });

  it("throws InvalidSessionIdError for malformed id", async () => {
    const m = await buildManager({
      agentResolver: stubAgentResolver(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      workspaceDir: scratch,
    });
    await expect(m.get("../escape")).rejects.toBeInstanceOf(InvalidSessionIdError);
  });
});

// ───── delete ────────────────────────────────────────────────

describe("delete()", () => {
  it("removes the metadata; workdir is preserved by default", async () => {
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    await m.delete(s.id);
    // Metadata gone (the session is no longer get-able).
    expect(await m.get(s.id)).toBeNull();
    // Workdir contents preserved (consistent with workspace/task purge=false default).
    const st = await stat(s.workdir);
    expect(st.isDirectory()).toBe(true);
  });

  it("removes the workdir when purge=true", async () => {
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    await m.delete(s.id, { purge: true });
    await expect(stat(s.workdir)).rejects.toThrow();
  });

  it("throws SessionNotFoundError for unknown id", async () => {
    const m = await buildManager({
      agentResolver: stubAgentResolver(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      workspaceDir: scratch,
    });
    await expect(m.delete("20260508-deadbeef")).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("validates id format", async () => {
    const m = await buildManager({
      agentResolver: stubAgentResolver(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      workspaceDir: scratch,
    });
    await expect(m.delete("../escape")).rejects.toBeInstanceOf(InvalidSessionIdError);
  });

  it("with purge=true: calls runtime.deleteState before removing row + workdir", async () => {
    const rt = new StubRuntime();
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    await m.delete(s.id, { purge: true });
    expect(rt.deleteStateCalls).toHaveLength(1);
    expect(rt.deleteStateCalls[0]).toBe(s.runtimeSessionId);
    // workdir gone
    await expect(stat(s.workdir)).rejects.toThrow();
  });

  it("with purge=true: runtime failure leaves both row and workdir intact", async () => {
    const rt = new StubRuntime();
    rt.deleteStateError = new RuntimeStateDeletionFailed("copilot", "anyid", new Error("EBUSY"));
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    await expect(m.delete(s.id, { purge: true })).rejects.toBeInstanceOf(
      RuntimeStateDeletionFailed,
    );
    // workdir survives — caller can retry without partial state
    const st = await stat(s.workdir);
    expect(st.isDirectory()).toBe(true);
    // row also survives — m.get(...) still finds it
    expect(await m.get(s.id)).not.toBeNull();
  });

  it("default (archive): does NOT call runtime.deleteState and preserves workdir", async () => {
    const rt = new StubRuntime();
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    await m.delete(s.id);
    expect(rt.deleteStateCalls).toEqual([]);
    // workdir preserved on disk for recovery / inspection
    const st = await stat(s.workdir);
    expect(st.isDirectory()).toBe(true);
    // but the row is gone — m.get(...) returns null
    expect(await m.get(s.id)).toBeNull();
  });
});

// ───── buildLaunch ──────────────────────────────────────────

describe("buildInteractiveLaunch()", () => {
  it("returns launch command for a real session", async () => {
    const rt = new StubRuntime();
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    const c = await m.buildInteractiveLaunch(s.id);
    expect(c.cmd).toBe("stub");
    expect(c.cwd).toBe(s.workdir);
    expect(c.args).toEqual([`--id=${s.runtimeSessionId}`]);
    // Verify the manager threads its own workspaceDir down to the runtime.
    // TS parameter-bivariance lets a stub silently accept fewer args than
    // the interface declares; pinning the value at the seam catches a
    // future refactor that drops or transposes the argument.
    expect(rt.buildLaunchCalls).toHaveLength(1);
    expect(rt.buildLaunchCalls[0]?.workspaceDir).toBe(scratch);
  });

  it("throws SessionNotFoundError for unknown", async () => {
    const m = await buildManager({
      agentResolver: stubAgentResolver(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      workspaceDir: scratch,
    });
    await expect(m.buildInteractiveLaunch("20260508-deadbeef")).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it("persists lastLaunchMode after a successful launch", async () => {
    const rt = new StubRuntime();
    const orm = makeDb();
    const m = new SessionService({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      db: orm.db,
    });
    const s = await m.create({ agent: "demo" });
    await m.buildInteractiveLaunch(s.id, { remote: true });
    expect((await new SessionRepository({ db: orm.db }).findById(s.id))?.lastLaunchMode).toBe(
      "remote",
    );
    await m.buildInteractiveLaunch(s.id, { remote: false });
    expect((await new SessionRepository({ db: orm.db }).findById(s.id))?.lastLaunchMode).toBe(
      "local",
    );
  });

  it("buildLaunch's lastLaunchMode write does not clobber a concurrent runtimeSessionId update", async () => {
    // Concurrent-writer contract: while `buildInteractiveLaunch` is in
    // flight, a parallel writer (e.g. a direct drizzle update on
    // `runtime_session_id`) must not be clobbered. `patchLastLaunchMode`
    // scopes its write to a single column, so both updates survive.
    const rt = new StubRuntime();
    const orm = makeDb();
    const m = new SessionService({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      db: orm.db,
    });
    const s = await m.create({ agent: "demo" });
    const before = await new SessionRepository({ db: orm.db }).findById(s.id);
    if (before === undefined) throw new Error("session row missing after create");
    // Fire both writes concurrently. The "parallel writer" path uses a
    // direct drizzle update on runtime_session_id only — matches what a
    // discovery-runtime's refresh path would do.
    await Promise.all([
      m.buildInteractiveLaunch(s.id, { remote: true }),
      (async () => {
        const { eq } = await import("drizzle-orm");
        const { sessions } = await import("../src/schema.js");
        orm.db
          .update(sessions)
          .set({ runtimeSessionId: "from-parallel-writer" })
          .where(eq(sessions.id, s.id))
          .run();
      })(),
    ]);
    const after = await new SessionRepository({ db: orm.db }).findById(s.id);
    expect(after?.runtimeSessionId).toBe("from-parallel-writer");
    expect(after?.lastLaunchMode).toBe("remote");
  });

  // ─── env injection ──────────────────────────────────────────────
  //
  // SessionService layers per-session work-context env
  // (EMPLOKE_WORKSPACE / EMPLOKE_WORKSPACE_DIR / EMPLOKE_WORK_KIND /
  // EMPLOKE_WORK_ID / EMPLOKE_WORK_DIR) onto the LaunchCommand env
  // produced by the runtime adapter. The runtime owns cross-cutting env
  // (EMPLOKE_SERVER, EMPLOKE_SHARED_DIR, …); this layer is purely
  // per-session.

  it("layers all five EMPLOKE_* keys onto LaunchCommand.env with the right values", async () => {
    const rt = new StubRuntime();
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      workspaceId: "ws-uuid-alpha",
    });
    const s = await m.create({ agent: "demo" });
    const launch = await m.buildInteractiveLaunch(s.id);
    expect(launch.env).toBeDefined();
    expect(launch.env?.EMPLOKE_WORKSPACE).toBe("ws-uuid-alpha");
    expect(launch.env?.EMPLOKE_WORKSPACE_DIR).toBe(scratch);
    expect(launch.env?.EMPLOKE_WORK_KIND).toBe("session");
    expect(launch.env?.EMPLOKE_WORK_ID).toBe(s.id);
    // Per-session workdir lives at <sessionsDir>/<id>/ — WORK_DIR is
    // the cwd the user lands in; WORKSPACE_DIR is one level up's
    // workspace root.
    expect(launch.env?.EMPLOKE_WORK_DIR).toBe(s.workdir);
  });

  it("preserves runtime-supplied env and layers per-session keys on top", async () => {
    const rt = new StubRuntime();
    // The runtime owns cross-cutting env (EMPLOKE_SERVER,
    // EMPLOKE_SHARED_DIR, …) via its config. Here we simulate that by
    // returning a launch.env from the StubRuntime; SessionService must
    // pass it through unchanged and layer the per-session keys on top.
    rt.launchEnv = {
      EMPLOKE_SERVER: "http://127.0.0.1:8787",
      EMPLOKE_SHARED_DIR: "/abs/shared",
    };
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      workspaceId: "ws-uuid-beta",
    });
    const s = await m.create({ agent: "demo" });
    const launch = await m.buildInteractiveLaunch(s.id);
    expect(launch.env).toBeDefined();
    // Runtime-supplied keys flow through untouched.
    expect(launch.env?.EMPLOKE_SERVER).toBe("http://127.0.0.1:8787");
    expect(launch.env?.EMPLOKE_SHARED_DIR).toBe("/abs/shared");
    // Per-session keys are layered on top.
    expect(launch.env?.EMPLOKE_WORKSPACE).toBe("ws-uuid-beta");
    expect(launch.env?.EMPLOKE_WORK_ID).toBe(s.id);
  });

  it("per-session keys WIN on collision with runtime-supplied keys", async () => {
    const rt = new StubRuntime();
    rt.launchEnv = {
      EMPLOKE_WORKSPACE: "runtime-wrong",
      EMPLOKE_WORK_KIND: "task",
      EMPLOKE_WORK_DIR: "/runtime/wrong",
    };
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      workspaceId: "ws-uuid-delta",
    });
    const s = await m.create({ agent: "demo" });
    const launch = await m.buildInteractiveLaunch(s.id);
    expect(launch.env?.EMPLOKE_WORKSPACE).toBe("ws-uuid-delta");
    expect(launch.env?.EMPLOKE_WORK_KIND).toBe("session");
    expect(launch.env?.EMPLOKE_WORK_DIR).toBe(s.workdir);
  });

  it("stamps EMPLOKE_WORK_KIND='session' and EMPLOKE_WORK_ID=<sid> for the session under launch", async () => {
    const rt = new StubRuntime();
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      workspaceId: "ws-uuid-gamma",
    });
    const s1 = await m.create({ agent: "demo" });
    const s2 = await m.create({ agent: "demo" });
    const [l1, l2] = await Promise.all([
      m.buildInteractiveLaunch(s1.id),
      m.buildInteractiveLaunch(s2.id),
    ]);
    expect(l1.env?.EMPLOKE_WORK_KIND).toBe("session");
    expect(l2.env?.EMPLOKE_WORK_KIND).toBe("session");
    // Each launch carries its own session id (no cross-contamination).
    expect(l1.env?.EMPLOKE_WORK_ID).toBe(s1.id);
    expect(l2.env?.EMPLOKE_WORK_ID).toBe(s2.id);
    expect(l1.env?.EMPLOKE_WORK_ID).not.toBe(l2.env?.EMPLOKE_WORK_ID);
  });
});

// ───── spawnInteractive ──────────────────────────────────────────
//
// Wraps `buildInteractiveLaunch` and the injected `spawnFn`, returning
// the `SpawnSessionResult` discriminated union that the dashboard +
// CLI consume on `POST /sessions/:sid/spawn`. The wire-shape pinning
// test for that route lives in
// `packages/server/test/routes/spawn-response-shape.test.ts`.

describe("spawnInteractive()", () => {
  it("returns ok:true with launcher + display on a happy spawn", async () => {
    const rt = new StubRuntime();
    const spawnFn = vi.fn(async (cmd: LaunchCommand) => {
      expect(cmd.cmd).toBe("stub");
      return { launcher: "wt" as const };
    });
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      spawnFn,
    });
    const s = await m.create({ agent: "demo" });
    const result = await m.spawnInteractive(s.id);
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.launcher).toBe("wt");
      // `display` mirrors the LaunchCommand the stub runtime returned.
      expect(result.display).toBe(`stub ${s.workdir}`);
    }
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("threads opts.remote through to buildInteractiveLaunch (filters falsy out)", async () => {
    const rt = new StubRuntime();
    const buildSpy = vi.spyOn(rt, "buildInteractiveLaunch");
    const spawnFn = vi.fn(async () => ({ launcher: "wt" as const }));
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      spawnFn,
    });
    const s = await m.create({ agent: "demo" });

    await m.spawnInteractive(s.id, { remote: true });
    expect(buildSpy).toHaveBeenLastCalledWith(s.runtimeSessionId, s.workdir, expect.any(String), {
      remote: true,
    });

    // `opts.remote === false` and `undefined` MUST be filtered out;
    // `spawnInteractive` reapplies the same filter here so its caller
    // contract stays consistent with `buildInteractiveLaunch`'s.
    await m.spawnInteractive(s.id, { remote: false });
    expect(buildSpy).toHaveBeenLastCalledWith(
      s.runtimeSessionId,
      s.workdir,
      expect.any(String),
      {},
    );

    await m.spawnInteractive(s.id);
    expect(buildSpy).toHaveBeenLastCalledWith(
      s.runtimeSessionId,
      s.workdir,
      expect.any(String),
      {},
    );
  });

  it("returns ok:false with code='BuildLaunchError' and empty display when buildInteractiveLaunch throws an unknown error", async () => {
    const rt = new StubRuntime();
    // Use a bare `Error` whose `.name` we blank, to verify the
    // `"BuildLaunchError"` fallback fires (typed errors like
    // SessionNotFoundError carry their own `name` and are covered by
    // the next test).
    const spawnFn = vi.fn(async () => ({ launcher: "wt" as const }));
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      spawnFn,
    });
    const s = await m.create({ agent: "demo" });
    vi.spyOn(rt, "buildInteractiveLaunch").mockImplementationOnce(async () => {
      const e = new Error("custom build failure");
      Object.defineProperty(e, "name", { value: "", configurable: true });
      throw e;
    });
    const result = await m.spawnInteractive(s.id);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toBe("custom build failure");
      expect(result.code).toBe("BuildLaunchError");
      expect(result.display).toBe("");
    }
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("returns ok:false carrying err.name for a typed build error (SessionNotFoundError)", async () => {
    const rt = new StubRuntime();
    const spawnFn = vi.fn(async () => ({ launcher: "wt" as const }));
    const m = await buildManager({
      agentResolver: stubAgentResolver(),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      spawnFn,
    });
    // No `create()` → buildInteractiveLaunch throws SessionNotFoundError.
    const result = await m.spawnInteractive("20260508-deadbeef");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.code).toBe("SessionNotFoundError");
      // display empty because we never produced a LaunchCommand.
      expect(result.display).toBe("");
    }
    expect(spawnFn).not.toHaveBeenCalled();
  });

  // The three terminal-pkg error classes set `name` via
  // `override readonly name = "..."`. SessionService's mapping uses
  // `err.name` only (no `instanceof` against terminal classes —
  // forbidden under the architecture fence). Re-creating the same
  // shape via plain `Error` + `Object.defineProperty(name)` here keeps
  // the test in the session pkg's own scope; the terminal-class
  // verification lives in the server pinning test
  // (`packages/server/test/routes/spawn-response-shape.test.ts`),
  // which CAN value-import terminal because test files are out of
  // scope for the architecture fence.
  it.each([
    ["NoTerminalFoundError", "No supported terminal emulator was found on this system."],
    ["TerminalSpawnFailedError", "Failed to launch wt: ENOENT"],
    ["UnsupportedPlatformError", "Unsupported platform for terminal launch: aix"],
  ])("returns ok:false with code=%s + cmd.display when spawnFn throws an %s-named error", async (errName, errMsg) => {
    const rt = new StubRuntime();
    const spawnFn = vi.fn(async () => {
      const e = new Error(errMsg);
      Object.defineProperty(e, "name", { value: errName, configurable: true });
      throw e;
    });
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      spawnFn,
    });
    const s = await m.create({ agent: "demo" });
    const result = await m.spawnInteractive(s.id);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.code).toBe(errName);
      expect(result.error).toBe(errMsg);
      // display lifted from the LaunchCommand StubRuntime returned.
      expect(result.display).toBe(`stub ${s.workdir}`);
    }
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("falls back to code='SpawnError' when spawnFn throws an error with no name", async () => {
    const rt = new StubRuntime();
    const spawnFn = vi.fn(async () => {
      const e = new Error("anonymous");
      Object.defineProperty(e, "name", { value: "", configurable: true });
      throw e;
    });
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      spawnFn,
    });
    const s = await m.create({ agent: "demo" });
    const result = await m.spawnInteractive(s.id);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.code).toBe("SpawnError");
      expect(result.error).toBe("anonymous");
    }
  });

  it("throws when spawnFn was not injected at compose time", async () => {
    const rt = new StubRuntime();
    const m = await buildManager({
      agentResolver: stubAgentResolver({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      workspaceDir: scratch,
      // spawnFn intentionally omitted
    });
    const s = await m.create({ agent: "demo" });
    await expect(m.spawnInteractive(s.id)).rejects.toThrow(/no spawnFn/);
  });
});
