import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";
import type { LaunchCommand, Runtime } from "@emploke/runtime";
import {
  RuntimeProvisionFailed,
  RuntimeRegistry,
  RuntimeStateDeletionFailed,
  UnknownRuntimeError,
} from "@emploke/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentNotFoundError,
  InvalidSessionIdError,
  SessionManager,
  type SessionManagerConfig,
  SessionNotFoundError,
  SqliteSessionRepository,
} from "../src/index.js";

// ───── helpers ──────────────────────────────────────────────

let sessionsDir: string;
let scratch: string;
let catalogDir: string;

/**
 * Per-test repos that the buildManager helper hands out. Tracked so
 * afterEach can close them — important on Windows where leaked WAL
 * sidecar handles would block the temp-dir `rm`. Using `:memory:`
 * SQLite means there's no on-disk file to leak in the first place,
 * but we still close to release any internal handles.
 */
let openRepos: SqliteSessionRepository[] = [];

function makeRepo(): SqliteSessionRepository {
  const repo = new SqliteSessionRepository(":memory:");
  openRepos.push(repo);
  return repo;
}

/**
 * Construct a `SessionManager` with a fresh `:memory:` SQLite
 * repository injected. Tests that need to inspect the persisted state
 * can override `opts.repository` with their own repo instance (the
 * spread order means `opts` wins over the default).
 */
function buildManager(opts: SessionManagerConfig): SessionManager {
  return new SessionManager({ repository: makeRepo(), ...opts });
}

beforeEach(async () => {
  sessionsDir = await mkdtemp(path.join(tmpdir(), "emploke-sessions-root-"));
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-sessions-scratch-"));
  catalogDir = await mkdtemp(path.join(tmpdir(), "emploke-catalog-"));
});
afterEach(async () => {
  for (const r of openRepos) r.close();
  openRepos = [];
  await rm(sessionsDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
  await rm(catalogDir, { recursive: true, force: true });
});

interface StubCatalogOpts {
  agents?: Record<string, AgentResolveResult>;
  resolveError?: Error;
}

function stubCatalog(opts: StubCatalogOpts = {}): CatalogManager {
  const agents = opts.agents ?? {};
  return {
    catalogDir,
    async resolveAgent(name: string): Promise<AgentResolveResult> {
      if (opts.resolveError) throw opts.resolveError;
      const a = agents[name];
      if (!a) throw new Error(`agent not found in catalog: "${name}"`);
      return a;
    },
  } as unknown as CatalogManager;
}

const fakeAgentResolve = (name: string): AgentResolveResult =>
  ({
    agent: { name, description: "x", version: "0.0.1" },
    agentPath: path.join(catalogDir, "agents", name),
    skills: [],
    mcps: [],
  }) as unknown as AgentResolveResult;

/**
 * A configurable in-memory Runtime that mimics the contract without touching
 * any real CLI. Defaults: provision writes a minimal AGENTS.md so
 * readAgentName() finds the right name; readMetadata returns null (no activity).
 */
class StubRuntime implements Runtime {
  readonly kind: string;
  provisionCalls: { workdir: string; agent: AgentResolveResult }[] = [];
  readMetadataCalls: string[] = [];
  deleteStateCalls: string[] = [];
  buildLaunchCalls: {
    runtimeSessionId: string | null;
    workdir: string;
    workspaceDir: string;
  }[] = [];

  /** Defaults to a stable UUID for determinism. */
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

  constructor(kind = "copilot") {
    this.kind = kind;
  }

  async provision(
    workdir: string,
    agent: AgentResolveResult,
  ): Promise<{ runtimeSessionId: string | null }> {
    this.provisionCalls.push({ workdir, agent });
    if (this.provisionError) throw this.provisionError;
    await mkdir(workdir, { recursive: true });
    await writeFile(
      path.join(workdir, "AGENTS.md"),
      `---\nname: ${agent.agent.name}\n---\n# agent\n`,
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
  const calls: { msg: string; meta?: object }[] = [];
  return {
    logger: {
      warn: (msg: string, meta?: object) => calls.push({ msg, ...(meta ? { meta } : {}) }),
    },
    calls,
  };
};

// ───── construction ──────────────────────────────────────────

describe("SessionManager construction", () => {
  it("constructs with catalog + runtimeRegistry + sessionsDir", () => {
    const m = buildManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
      workspaceDir: scratch,
    });
    expect(m).toBeDefined();
  });
});

// ───── create ────────────────────────────────────────────────

describe("create()", () => {
  it("provisions, persists state, returns Session shape", async () => {
    const rt = new StubRuntime();
    const repo = makeRepo();
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
      now: fixedNow("2026-05-08T01:05:00.000Z"),
      randomBytes: seqRandom(),
      repository: repo,
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
    // through.
    const persisted = await repo.read(s.id);
    expect(persisted).toEqual({
      runtime: "copilot",
      createdAt: "2026-05-08T01:05:00.000Z",
      runtimeSessionId: "12345678-1234-1234-1234-1234567890ab",
    });
  });

  it("throws AgentNotFoundError for empty agent", async () => {
    const m = buildManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
      workspaceDir: scratch,
    });
    await expect(m.create({ agent: "" })).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it("throws AgentNotFoundError when catalog rejects", async () => {
    const m = buildManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
      workspaceDir: scratch,
    });
    await expect(m.create({ agent: "missing" })).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it("throws UnknownRuntimeError when runtime kind is not registered", async () => {
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(new StubRuntime("copilot")),
      sessionsDir,
      workspaceDir: scratch,
    });
    await expect(m.create({ agent: "demo", runtime: "gemini" })).rejects.toBeInstanceOf(
      UnknownRuntimeError,
    );
  });

  it("uses defaultRuntime override", async () => {
    const claudeRt = new StubRuntime("claude");
    const reg = new RuntimeRegistry();
    reg.register(claudeRt);
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: reg,
      defaultRuntime: "claude",
      sessionsDir,
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    expect(s.runtime).toBe("claude");
  });

  it("cleans up workdir on provisioner failure", async () => {
    const rt = new StubRuntime();
    rt.provisionError = new RuntimeProvisionFailed("copilot", "/x", new Error("boom"));
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
    });
    await expect(m.create({ agent: "demo" })).rejects.toBeInstanceOf(RuntimeProvisionFailed);
    const fsp = await import("node:fs/promises");
    expect(await fsp.readdir(sessionsDir)).toEqual([]);
  });

  it("supports null runtimeSessionId at create time (gemini-style)", async () => {
    const rt = new StubRuntime();
    rt.provisionId = null;
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    expect(s.runtimeSessionId).toBeNull();
  });
});

// ───── list ──────────────────────────────────────────────────

describe("list()", () => {
  it("returns empty when sessionsDir does not exist", async () => {
    const m = buildManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir: path.join(sessionsDir, "missing"),
      workspaceDir: scratch,
    });
    expect(await m.list()).toEqual([]);
  });

  it("ignores stray workdirs that have no corresponding state row", async () => {
    const r = recorder();
    const rt = new StubRuntime();
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
      logger: r.logger,
    });
    await m.create({ agent: "demo" });
    // Directories on disk with no SQLite row are invisible to list()
    // — the repository drives the listing, not a directory scan. The
    // old FS-backed tests covered the same scenario via "dirs without
    // session.json"; the SQLite version of the same invariant is
    // "dirs without a row".
    await mkdir(path.join(sessionsDir, "20260101-deadbeef"), { recursive: true });
    await mkdir(path.join(sessionsDir, "not-a-session"), { recursive: true });
    const out = await m.list();
    expect(out).toHaveLength(1);
  });

  it("filters by agent", async () => {
    const m = buildManager({
      catalog: stubCatalog({
        agents: { a: fakeAgentResolve("a"), b: fakeAgentResolve("b") },
      }),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
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
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
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
    const m = buildManager({
      catalog: stubCatalog({
        agents: { a: fakeAgentResolve("a"), b: fakeAgentResolve("b") },
      }),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
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
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
    });
    await m.create({ agent: "demo" });
    const [out] = await m.list();
    expect(out?.lastActiveAt).toBe("2026-05-08T02:00:00.000Z");
    expect(out?.preview).toBe("did stuff");
  });

  it("treats null refresh as no activity (lastActiveAt/preview stay null)", async () => {
    const rt = new StubRuntime();
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
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
    const sharedRepo = makeRepo();
    const rtA = new StubRuntime();
    const m1 = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rtA),
      sessionsDir,
      workspaceDir: scratch,
      repository: sharedRepo,
    });
    await m1.create({ agent: "demo" });

    const m2 = buildManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime("gemini")),
      sessionsDir,
      workspaceDir: scratch,
      logger: r.logger,
      repository: sharedRepo,
    });
    expect(await m2.list()).toEqual([]);
    expect(r.calls.some((c) => c.msg.includes("unregistered runtime"))).toBe(true);
  });

  // NOTE: the old "discovery" behaviour (provisionId=null, runtime
  // mints + returns an id later via refresh) is intentionally not
  // covered by the new Runtime contract — `readMetadata` requires a
  // pre-known `runtimeSessionId`. A future Gemini-style adapter will
  // add a separate `discoverRuntimeSessionId(workdir)` hook for that
  // case; tracked separately. For now, this case test is deferred.
  it.skip("persists discovered runtimeSessionId back to the repository (gemini-style)", async () => {
    const rt = new StubRuntime();
    rt.provisionId = null;
    rt.readMetadataResult = {
      lastActiveAt: "2026-05-08T02:00:00.000Z",
      title: null,
      userTitled: false,
    };
    const repo = makeRepo();
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
      repository: repo,
    });
    const s = await m.create({ agent: "demo" });
    const [out] = await m.list();
    expect(out?.runtimeSessionId).toBe("33333333-3333-3333-3333-333333333333");
    const persisted = await repo.read(s.id);
    expect(persisted?.runtimeSessionId).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("sorts never-launched sessions first, then active by lastActiveAt desc (#43)", async () => {
    const rt = new StubRuntime();
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
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
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
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
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
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
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    const got = await m.get(s.id);
    expect(got?.id).toBe(s.id);
  });

  it("returns null for valid-but-unknown id", async () => {
    const m = buildManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
      workspaceDir: scratch,
    });
    expect(await m.get("20260508-deadbeef")).toBeNull();
  });

  it("throws InvalidSessionIdError for malformed id", async () => {
    const m = buildManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
      workspaceDir: scratch,
    });
    await expect(m.get("../escape")).rejects.toBeInstanceOf(InvalidSessionIdError);
  });
});

// ───── delete ────────────────────────────────────────────────

describe("delete()", () => {
  it("removes the metadata; workdir is preserved by default", async () => {
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
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
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    await m.delete(s.id, { purge: true });
    await expect(stat(s.workdir)).rejects.toThrow();
  });

  it("throws SessionNotFoundError for unknown id", async () => {
    const m = buildManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
      workspaceDir: scratch,
    });
    await expect(m.delete("20260508-deadbeef")).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("validates id format", async () => {
    const m = buildManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
      workspaceDir: scratch,
    });
    await expect(m.delete("../escape")).rejects.toBeInstanceOf(InvalidSessionIdError);
  });

  it("with purge=true: calls runtime.deleteState before removing row + workdir", async () => {
    const rt = new StubRuntime();
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
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
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
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
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
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
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
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

  // Same discovery limitation as above — defer until the Gemini
  // adapter PR designs the discoverRuntimeSessionId hook.
  it.skip("calls runtime.refresh first so a discovery-runtime can mint an id", async () => {
    const rt = new StubRuntime();
    rt.provisionId = null;
    rt.readMetadataResult = {
      lastActiveAt: "2026-05-08T02:00:00.000Z",
      title: null,
      userTitled: false,
    };
    const m = buildManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    const c = await m.buildInteractiveLaunch(s.id);
    expect(c.args).toEqual(["--id=abcdef12-3456-7890-abcd-ef1234567890"]);
  });

  it("throws SessionNotFoundError for unknown", async () => {
    const m = buildManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
      workspaceDir: scratch,
    });
    await expect(m.buildInteractiveLaunch("20260508-deadbeef")).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it("persists lastLaunchMode after a successful launch", async () => {
    const rt = new StubRuntime();
    const repo = makeRepo();
    const m = new SessionManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
      repository: repo,
    });
    const s = await m.create({ agent: "demo" });
    await m.buildInteractiveLaunch(s.id, { remote: true });
    expect((await repo.read(s.id))?.lastLaunchMode).toBe("remote");
    await m.buildInteractiveLaunch(s.id, { remote: false });
    expect((await repo.read(s.id))?.lastLaunchMode).toBe("local");
  });

  it("buildLaunch's lastLaunchMode write does not clobber a concurrent runtimeSessionId update", async () => {
    // Reproduces issue #56's interlock: while `buildLaunch` is in
    // flight, a parallel writer (e.g. a future discovery-runtime's
    // `refreshSession` save, or any other `repository.save` path)
    // updates `runtimeSessionId`. The old read-merge-save in
    // `buildLaunch` would silently overwrite that update with the
    // value it had read at the start. The new `patchLastLaunchMode`
    // path scopes its write to a single column, so both updates
    // survive.
    const rt = new StubRuntime();
    const repo = makeRepo();
    const m = new SessionManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
      repository: repo,
    });
    const s = await m.create({ agent: "demo" });
    const before = await repo.read(s.id);
    if (before === null) throw new Error("session row missing after create");
    // Fire both writes concurrently.
    await Promise.all([
      m.buildInteractiveLaunch(s.id, { remote: true }),
      repo.save(s.id, { ...before, runtimeSessionId: "from-parallel-writer" }),
    ]);
    const after = await repo.read(s.id);
    expect(after?.runtimeSessionId).toBe("from-parallel-writer");
    expect(after?.lastLaunchMode).toBe("remote");
  });
});

// Suppress unused imports warning for vi (kept available for future tests).
void vi;
