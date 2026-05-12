/**
 * End-to-end smoke test that exercises the *real* spawn → exit watcher →
 * persist chain.
 *
 * Every other test in this package stubs `Runtime.launchHeadless` and
 * hand-resolves `TaskHandle.exit`, which gives us fast deterministic CI
 * but leaves the production-critical chain of
 *
 *   `child_process.spawn` → `child.on('exit')` → `applyTerminal()` →
 *   `repository.save()` → `list()`
 *
 * effectively 0% covered. This file plugs that hole with a minimum
 * viable smoke test using `process.execPath -e "process.exit(<code>)"`
 * as a stand-in agent — no dependency on Copilot/Gemini/etc.
 *
 * Scope is deliberately narrow: dispatch a real child, await terminal,
 * confirm the persisted task row reflects the right status. A fuller
 * integration suite (real `events.jsonl` tail, junctions, cancel
 * semantics, sanitised spawn errors) is tracked in #29.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";
import type { LaunchCommand, Runtime, RuntimeHandle } from "@emploke/runtime";
import { RuntimeRegistry } from "@emploke/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DispatchOpts,
  SqliteTaskRepository,
  type Task,
  TaskManager,
} from "../../src/index.js";

// ───────── fixture lifecycle ─────────────────────────────────

let tasksDir: string;
let openRepos: SqliteTaskRepository[] = [];

beforeEach(async () => {
  tasksDir = await mkdtemp(path.join(tmpdir(), "emploke-real-spawn-"));
});

afterEach(async () => {
  for (const r of openRepos) r.close();
  openRepos = [];
  await rm(tasksDir, { recursive: true, force: true });
});

// ───────── real-spawn runtime ────────────────────────────────

/**
 * Minimum viable Runtime that real-spawns `process.execPath -e <script>`
 * as a stand-in for any third-party CLI. `scripts` is keyed by agent
 * name (the same key the catalog stub resolves) so a single runtime
 * instance can serve multiple agents with different exit behaviours.
 */
class RealNodeRuntime implements Runtime {
  readonly kind = "node-test";
  /** Children we spawned, kept around so afterEach can sweep stragglers. */
  readonly children: ChildProcess[] = [];

  constructor(private readonly scripts: Record<string, string>) {}

  async provision(): Promise<{ runtimeSessionId: string | null }> {
    return { runtimeSessionId: null };
  }
  async buildInteractiveLaunch(_rsid: string | null, workdir: string): Promise<LaunchCommand> {
    return { cmd: "noop", args: [], cwd: workdir, display: "noop" };
  }
  async deleteState(): Promise<void> {}

  async launchHeadless(opts: {
    workdir: string;
    agent: AgentResolveResult;
    prompt: string;
  }): Promise<RuntimeHandle> {
    const agentName = opts.agent.agent.name;
    const script = this.scripts[agentName] ?? "process.exit(0)";
    const child = nodeSpawn(process.execPath, ["-e", script], {
      cwd: opts.workdir,
      stdio: "ignore",
      windowsHide: true,
    });
    this.children.push(child);

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    return {
      pid: child.pid as number,
      sessionDir: Promise.resolve(opts.workdir),
      exit,
      kill: () => child.kill(),
    };
  }
}

// ───────── catalog stub ───────────────────────────────────────

const fakeAgentResolve = (name: string): AgentResolveResult =>
  ({
    agent: { name, description: "real-spawn smoke", version: "0.0.1" },
    agentPath: `/tmp/catalog/agents/${name}`,
    skills: [],
    mcps: [],
  }) as unknown as AgentResolveResult;

const stubCatalog = (agentNames: readonly string[]): CatalogManager =>
  ({
    catalogDir: "/tmp/catalog",
    async resolveAgent(name: string): Promise<AgentResolveResult> {
      if (!agentNames.includes(name)) throw new Error(`unknown agent: ${name}`);
      return fakeAgentResolve(name);
    },
    async getAgentEntry(name: string) {
      if (!agentNames.includes(name)) return null;
      return { agent: { fqn: name } as unknown, status: "ready" } as unknown;
    },
  }) as unknown as CatalogManager;

// ───────── helpers ────────────────────────────────────────────

const dispatchOf = (overrides: Partial<DispatchOpts> = {}): DispatchOpts => ({
  agent: "exit-zero",
  instructions: "smoke",
  runtime: "node-test",
  ...overrides,
});

async function awaitTerminal(m: TaskManager, id: string, timeoutMs = 10_000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await m.get(id);
    if (t && t.status !== "running" && t.status !== "not_started") return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`awaitTerminal: task ${id} did not reach terminal status within ${timeoutMs}ms`);
}

const makeManager = (
  catalog: CatalogManager,
  runtime: Runtime,
): { m: TaskManager; repo: SqliteTaskRepository } => {
  const reg = new RuntimeRegistry();
  reg.register(runtime);
  // Use `:memory:` so the test owns the DB lifecycle (no file to leak,
  // no Windows EBUSY on cleanup).
  const repo = new SqliteTaskRepository(":memory:");
  openRepos.push(repo);
  const m = new TaskManager({
    catalog,
    runtimeRegistry: reg,
    tasksDir,
    workspaceDir: tasksDir,
    repository: repo,
  });
  return { m, repo };
};

// ───────── tests ──────────────────────────────────────────────

describe("real-spawn smoke", () => {
  it("dispatch → real child exits 0 → status persists as 'success'", async () => {
    const runtime = new RealNodeRuntime({ "exit-zero": "process.exit(0)" });
    const { m, repo } = makeManager(stubCatalog(["exit-zero"]), runtime);

    const t = await m.dispatch(dispatchOf({ agent: "exit-zero" }));
    const final = await awaitTerminal(m, t.id);

    expect(final.status).toBe("success");

    const persisted = await repo.read(t.id);
    expect(persisted?.status).toBe("success");
  });

  it("dispatch → real child exits non-zero → status persists as 'failure'", async () => {
    const runtime = new RealNodeRuntime({ "exit-one": "process.exit(1)" });
    const { m, repo } = makeManager(stubCatalog(["exit-one"]), runtime);

    const t = await m.dispatch(dispatchOf({ agent: "exit-one" }));
    const final = await awaitTerminal(m, t.id);

    expect(final.status).toBe("failure");

    const persisted = await repo.read(t.id);
    expect(persisted?.status).toBe("failure");
  });
});
