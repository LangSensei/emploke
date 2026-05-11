import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";
import type { LaunchCommand, Runtime, Session } from "@emploke/runtime";
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
  SessionNotFoundError,
} from "../src/index.js";

// session.json wire format constants — these used to be exported from
// @emploke/session but are now FsSessionRepository implementation
// details. The tests still verify on-disk shape so they redeclare the
// constants locally.
const SESSION_FILE_NAME = "session.json";
const CURRENT_SCHEMA_VERSION = 1;

// ───── helpers ──────────────────────────────────────────────

let sessionsDir: string;
let scratch: string;
let catalogDir: string;

beforeEach(async () => {
  sessionsDir = await mkdtemp(path.join(tmpdir(), "emploke-sessions-root-"));
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-sessions-scratch-"));
  catalogDir = await mkdtemp(path.join(tmpdir(), "emploke-catalog-"));
});
afterEach(async () => {
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
 * readAgentName() finds the right name; refresh returns null (no activity).
 */
class StubRuntime implements Runtime {
  readonly kind: string;
  provisionCalls: { workdir: string; agent: AgentResolveResult }[] = [];
  refreshCalls: Session[] = [];
  deleteStateCalls: Session[] = [];
  buildLaunchCalls: { session: Session; workspaceDir: string }[] = [];

  /** Defaults to a stable UUID for determinism. */
  provisionId: string | null = "12345678-1234-1234-1234-1234567890ab";
  /** If set, provision throws this. */
  provisionError: Error | null = null;
  /** If set, refresh returns this. */
  refreshResult: { lastActiveAt: string; preview: string | null; runtimeSessionId: string } | null =
    null;
  /** Per-session-id overrides for refresh. Takes precedence over refreshResult. */
  refreshResultBy: Map<
    string,
    { lastActiveAt: string; preview: string | null; runtimeSessionId: string } | null
  > = new Map();
  /** If set, refresh throws this. */
  refreshError: Error | null = null;
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
    return { runtimeSessionId: this.provisionId };
  }

  async refresh(s: Session) {
    this.refreshCalls.push(s);
    if (this.refreshError) throw this.refreshError;
    if (this.refreshResultBy.has(s.id)) return this.refreshResultBy.get(s.id) ?? null;
    return this.refreshResult;
  }

  async buildLaunch(s: Session, workspaceDir: string): Promise<LaunchCommand> {
    this.buildLaunchCalls.push({ session: s, workspaceDir });
    return {
      cmd: "stub",
      args: s.runtimeSessionId === null ? [] : [`--id=${s.runtimeSessionId}`],
      cwd: s.workdir,
      display: `stub ${s.workdir}`,
    };
  }

  async deleteState(s: Session): Promise<void> {
    this.deleteStateCalls.push(s);
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
    const m = new SessionManager({
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
  it("provisions, persists session.json, returns Session shape", async () => {
    const rt = new StubRuntime();
    const m = new SessionManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
      now: fixedNow("2026-05-08T01:05:00.000Z"),
      randomBytes: seqRandom(),
    });
    const s = await m.create({ agent: "demo" });

    expect(s.agent).toBe("public/demo");
    expect(s.runtime).toBe("copilot");
    expect(s.runtimeSessionId).toBe("12345678-1234-1234-1234-1234567890ab");
    expect(s.lastActiveAt).toBeNull();
    expect(s.preview).toBeNull();
    expect(s.workdir).toBe(path.join(sessionsDir, s.id));
    expect(rt.provisionCalls).toHaveLength(1);

    const persisted = JSON.parse(await readFile(path.join(s.workdir, SESSION_FILE_NAME), "utf8"));
    expect(persisted).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      runtime: "copilot",
      createdAt: "2026-05-08T01:05:00.000Z",
      runtimeSessionId: "12345678-1234-1234-1234-1234567890ab",
    });
  });

  it("throws AgentNotFoundError for empty agent", async () => {
    const m = new SessionManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
      workspaceDir: scratch,
    });
    await expect(m.create({ agent: "" })).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it("throws AgentNotFoundError when catalog rejects", async () => {
    const m = new SessionManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
      workspaceDir: scratch,
    });
    await expect(m.create({ agent: "missing" })).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it("throws UnknownRuntimeError when runtime kind is not registered", async () => {
    const m = new SessionManager({
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
    const m = new SessionManager({
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
    const m = new SessionManager({
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
    const m = new SessionManager({
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
    const m = new SessionManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir: path.join(sessionsDir, "missing"),
      workspaceDir: scratch,
    });
    expect(await m.list()).toEqual([]);
  });

  it("ignores dirs without a readable session.json", async () => {
    const r = recorder();
    const rt = new StubRuntime();
    const m = new SessionManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
      logger: r.logger,
    });
    await m.create({ agent: "demo" });
    await mkdir(path.join(sessionsDir, "20260101-deadbeef"), { recursive: true });
    await mkdir(path.join(sessionsDir, "not-a-session"), { recursive: true });
    const out = await m.list();
    expect(out).toHaveLength(1);
  });

  it("ignores dirs whose session.json is corrupted", async () => {
    const r = recorder();
    const rt = new StubRuntime();
    const m = new SessionManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
      logger: r.logger,
    });
    await m.create({ agent: "demo" });
    const stray = path.join(sessionsDir, "20260101-cafebabe");
    await mkdir(stray, { recursive: true });
    await writeFile(path.join(stray, SESSION_FILE_NAME), "{not json", "utf8");
    const out = await m.list();
    expect(out).toHaveLength(1);
    // Corruption is logged via FsSessionRepository's list-time drop (no
    // explicit warn from the manager — the repository swallows the
    // typed error so the listing keeps working).
  });

  it("filters by agent", async () => {
    const m = new SessionManager({
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
    const m = new SessionManager({
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

    rt.refreshCalls.length = 0;
    const onlyNew = await m.list({ createdSince: "2026-01-15T00:00:00.000Z" });
    expect(onlyNew).toHaveLength(1);
    expect(onlyNew[0]?.createdAt).toBe("2026-02-01T00:00:00.000Z");
    // Critical: refresh must NOT have been called for the excluded entry.
    expect(rt.refreshCalls).toHaveLength(1);
  });

  it("createdSince combined with agent narrows further", async () => {
    let nowMs = Date.UTC(2026, 0, 1);
    const m = new SessionManager({
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
    rt.refreshResult = {
      lastActiveAt: "2026-05-08T02:00:00.000Z",
      preview: "did stuff",
      runtimeSessionId: rt.provisionId as string,
    };
    const m = new SessionManager({
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
    const m = new SessionManager({
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
    // registry doesn't know "copilot".
    const rtA = new StubRuntime();
    const m1 = new SessionManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rtA),
      sessionsDir,
      workspaceDir: scratch,
    });
    await m1.create({ agent: "demo" });

    const m2 = new SessionManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime("gemini")),
      sessionsDir,
      workspaceDir: scratch,
      logger: r.logger,
    });
    expect(await m2.list()).toEqual([]);
    expect(r.calls.some((c) => c.msg.includes("unregistered runtime"))).toBe(true);
  });

  it("persists discovered runtimeSessionId back to session.json (gemini-style)", async () => {
    const rt = new StubRuntime();
    rt.provisionId = null;
    rt.refreshResult = {
      lastActiveAt: "2026-05-08T02:00:00.000Z",
      preview: null,
      runtimeSessionId: "33333333-3333-3333-3333-333333333333",
    };
    const m = new SessionManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    const [out] = await m.list();
    expect(out?.runtimeSessionId).toBe("33333333-3333-3333-3333-333333333333");
    const persisted = JSON.parse(await readFile(path.join(s.workdir, SESSION_FILE_NAME), "utf8"));
    expect(persisted.runtimeSessionId).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("sorts active sessions by lastActiveAt desc, never-launched ones at the bottom (#43)", async () => {
    const rt = new StubRuntime();
    const m = new SessionManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
    });
    // Three sessions: a is older but active in 2099, b/c are never launched
    // (lastActiveAt === null). The new sort puts active first, then null
    // by createdAt desc — so order is [a, c, b] regardless of c's
    // createdAt-> Wait: actually b is the second-created, c is third, so
    // createdAt(c) > createdAt(b). Result must be [a (active), c (newer null), b (older null)].
    rt.refreshResult = null;
    const a = await m.create({ agent: "demo" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await m.create({ agent: "demo" });
    await new Promise((r) => setTimeout(r, 5));
    const c = await m.create({ agent: "demo" });
    rt.refreshResultBy.set(a.id, {
      lastActiveAt: "2099-01-01T00:00:00.000Z",
      preview: null,
      runtimeSessionId: rt.provisionId as string,
    });
    const out = await m.list();
    expect(out.map((r) => r.id)).toEqual([a.id, c.id, b.id]);
  });

  it("activeSince filter drops sessions whose lastActiveAt is null or older than the cutoff", async () => {
    const rt = new StubRuntime();
    const m = new SessionManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
    });
    rt.refreshResult = null;
    const old = await m.create({ agent: "demo" });
    const recent = await m.create({ agent: "demo" });
    const never = await m.create({ agent: "demo" });
    rt.refreshResultBy.set(old.id, {
      lastActiveAt: "2026-01-01T00:00:00.000Z",
      preview: null,
      runtimeSessionId: rt.provisionId as string,
    });
    rt.refreshResultBy.set(recent.id, {
      lastActiveAt: "2099-12-31T00:00:00.000Z",
      preview: null,
      runtimeSessionId: rt.provisionId as string,
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
    const m = new SessionManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
      now: fixedNow("2026-05-08T01:05:00.000Z"),
    });
    rt.refreshResult = null;
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
    const m = new SessionManager({
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
    const m = new SessionManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
      workspaceDir: scratch,
    });
    expect(await m.get("20260508-deadbeef")).toBeNull();
  });

  it("throws InvalidSessionIdError for malformed id", async () => {
    const m = new SessionManager({
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
    const m = new SessionManager({
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
    const m = new SessionManager({
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
    const m = new SessionManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
      workspaceDir: scratch,
    });
    await expect(m.delete("20260508-deadbeef")).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("validates id format", async () => {
    const m = new SessionManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
      workspaceDir: scratch,
    });
    await expect(m.delete("../escape")).rejects.toBeInstanceOf(InvalidSessionIdError);
  });

  it("with deleteRuntimeState=true: calls runtime.deleteState before rm", async () => {
    const rt = new StubRuntime();
    const m = new SessionManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    await m.delete(s.id, { deleteRuntimeState: true });
    expect(rt.deleteStateCalls).toHaveLength(1);
    expect(rt.deleteStateCalls[0]?.id).toBe(s.id);
  });

  it("with deleteRuntimeState=true: surfaces failure and leaves workdir intact", async () => {
    const rt = new StubRuntime();
    rt.deleteStateError = new RuntimeStateDeletionFailed("copilot", "anyid", new Error("EBUSY"));
    const m = new SessionManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    await expect(m.delete(s.id, { deleteRuntimeState: true })).rejects.toBeInstanceOf(
      RuntimeStateDeletionFailed,
    );
    const st = await stat(s.workdir);
    expect(st.isDirectory()).toBe(true);
  });

  it("without deleteRuntimeState: does not call runtime.deleteState", async () => {
    const rt = new StubRuntime();
    const m = new SessionManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    await m.delete(s.id);
    expect(rt.deleteStateCalls).toEqual([]);
  });
});

// ───── buildLaunch ──────────────────────────────────────────

describe("buildLaunch()", () => {
  it("returns launch command for a real session", async () => {
    const rt = new StubRuntime();
    const m = new SessionManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    const c = await m.buildLaunch(s.id);
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

  it("calls runtime.refresh first so a discovery-runtime can mint an id", async () => {
    const rt = new StubRuntime();
    rt.provisionId = null;
    rt.refreshResult = {
      lastActiveAt: "2026-05-08T02:00:00.000Z",
      preview: null,
      runtimeSessionId: "abcdef12-3456-7890-abcd-ef1234567890",
    };
    const m = new SessionManager({
      catalog: stubCatalog({ agents: { demo: fakeAgentResolve("demo") } }),
      runtimeRegistry: makeRegistry(rt),
      sessionsDir,
      workspaceDir: scratch,
    });
    const s = await m.create({ agent: "demo" });
    const c = await m.buildLaunch(s.id);
    expect(c.args).toEqual(["--id=abcdef12-3456-7890-abcd-ef1234567890"]);
  });

  it("throws SessionNotFoundError for unknown", async () => {
    const m = new SessionManager({
      catalog: stubCatalog(),
      runtimeRegistry: makeRegistry(new StubRuntime()),
      sessionsDir,
      workspaceDir: scratch,
    });
    await expect(m.buildLaunch("20260508-deadbeef")).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

// Suppress unused imports warning for vi (kept available for future tests).
void vi;
