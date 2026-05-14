import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";
import crossSpawn from "cross-spawn";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCopilotHeadlessArgs,
  COPILOT_MCP_CONFIG,
  defaultSpawnImpl,
  type SpawnFn,
} from "../../src/copilot/launch-headless.js";
import {
  COPILOT_STDERR_LOG,
  COPILOT_STDOUT_LOG,
  launchCopilotHeadless,
  RuntimeHeadlessLaunchFailed,
  RuntimeProvisionFailed,
} from "../../src/index.js";
import { makeTestCatalog } from "./test-catalog.js";

let scratch: string;
let taskDir: string;
let stateDir: string;

const FIXED_UUID = "00000000-1111-2222-3333-444455556666";

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "rt-dispatch-"));
  taskDir = path.join(scratch, "task");
  stateDir = path.join(scratch, "copilot-state");
  await mkdir(taskDir, { recursive: true });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function buildAgent(): Promise<{ agent: AgentResolveResult; catalog: CatalogManager }> {
  const agentBody = "---\nname: demo\ndescription: d\nversion: 0.0.1\n---\n# demo\n";
  const { catalog } = await makeTestCatalog({
    agents: { demo: { "AGENTS.md": agentBody } },
  });
  return { agent: await catalog.resolveAgent("public/demo"), catalog };
}

interface FakeSpawn {
  spawn: SpawnFn;
  child: FakeChild;
  captures: { command: string; args: readonly string[]; options: unknown } | null;
}

class FakeChild extends EventEmitter {
  pid: number | undefined = 12345;
  stdout: Readable = new Readable({ read() {} });
  stderr: Readable = new Readable({ read() {} });
  killCalls = 0;
  killImpl: () => boolean = () => true;

  kill(): boolean {
    this.killCalls++;
    return this.killImpl();
  }
}

/**
 * Build a fake spawn that emits 'spawn' on the next microtask. Tests that
 * want to simulate spawn failure construct their own (see
 * "rejects with RuntimeHeadlessLaunchFailed").
 */
function makeFakeSpawn(): FakeSpawn {
  const child = new FakeChild();
  const captures: FakeSpawn["captures"] = null as FakeSpawn["captures"];
  const out: FakeSpawn = { spawn: null as unknown as SpawnFn, child, captures };
  out.spawn = ((command, args, options) => {
    out.captures = { command, args, options };
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ReturnType<SpawnFn>;
  }) as SpawnFn;
  return out;
}

describe("launchCopilotHeadless", () => {
  it("provisions the workdir before spawning", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "hello", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
      },
    );
    const md = await readFile(path.join(taskDir, "AGENTS.md"), "utf8");
    expect(md).toContain("demo");
  });

  it("pre-creates the session-state dir so it exists before the first event write", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    const handle = await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "hi", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
      },
    );
    const sessionDir = await handle.sessionDir;
    expect(sessionDir).toBe(path.join(stateDir, FIXED_UUID));
    expect((await stat(sessionDir)).isDirectory()).toBe(true);
  });

  it("spawns copilot with the expected non-interactive args", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "do thing", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
      },
    );
    expect(fake.captures).not.toBeNull();
    expect(fake.captures?.command).toBe("copilot");
    expect(fake.captures?.args).toEqual([
      "-p",
      "do thing",
      "--resume",
      FIXED_UUID,
      "--allow-all",
      "--no-ask-user",
      "--output-format",
      "json",
      "-C",
      taskDir,
    ]);
    const opts = fake.captures?.options as { cwd: string; stdio: unknown };
    expect(opts.cwd).toBe(taskDir);
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  // Workaround for upstream github/copilot-cli#3313 (tracked in emploke
  // #105): in non-interactive mode, the CLI silently filters out
  // workspace-level `.mcp.json` MCP servers — they never appear in the
  // agent's tool surface and emit no warning. Routing the same file
  // through `--additional-mcp-config @./.mcp.json` makes them load.
  //
  // The launcher gates the flag on `existsSync(<taskDir>/.mcp.json)` so
  // we don't pass a flag with nothing to load when the resolved agent
  // declares zero MCPs (provisionCopilotWorkdir skips the file in that
  // case). The existence probe runs AFTER provision so an agent that
  // contributes MCPs gets the flag the very first launch.
  it("appends --additional-mcp-config when <taskDir>/.mcp.json exists at spawn time", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    // Pre-write `.mcp.json` into the task dir to simulate the file the
    // provisioner would write for an MCP-bearing agent. The demo agent
    // used here declares no MCPs, so without this write the file would
    // be absent — that's what the no-flag test below covers.
    await writeFile(
      path.join(taskDir, COPILOT_MCP_CONFIG),
      JSON.stringify({ mcpServers: { example: { command: "noop" } } }),
      "utf8",
    );
    await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
      },
    );
    const args = fake.captures?.args ?? [];
    // Two argv entries (NOT a single combined string), appended at the
    // tail so the rest of the call shape stays stable.
    expect(args).toEqual([
      "-p",
      "x",
      "--resume",
      FIXED_UUID,
      "--allow-all",
      "--no-ask-user",
      "--output-format",
      "json",
      "-C",
      taskDir,
      "--additional-mcp-config",
      "@./.mcp.json",
    ]);
  });

  it("omits --additional-mcp-config when <taskDir>/.mcp.json is absent", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    // No `.mcp.json` written; demo agent has no MCPs so provision skips
    // the file. The launcher must not pass the flag — upstream rejects
    // `--additional-mcp-config` pointing at a non-existent path.
    await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
      },
    );
    const args = fake.captures?.args ?? [];
    expect(args).not.toContain("--additional-mcp-config");
    expect(args).not.toContain("@./.mcp.json");
  });

  it("honours an injected copilotBin override", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        copilotBin: "C:\\fake\\copilot.exe",
      },
    );
    expect(fake.captures?.command).toBe("C:\\fake\\copilot.exe");
  });

  // Cross-spawn handles the Windows-specific spawn footguns
  // (PATHEXT iteration, .cmd / .bat wrapping post-CVE-2024-27980,
  // cmd /S quote-stripping, shell-metachar escaping) inside the
  // library. The runtime contract here is intentionally narrow:
  // hand cross-spawn the bare bin name + argv + spawn opts.
  //
  // The two `it` blocks below verify the call SHAPE the launcher
  // hands to whatever spawn impl the deps inject. They cannot, by
  // construction, catch a regression where someone reverts the
  // production fallback `defaultSpawnImpl` from cross-spawn back
  // to `node:child_process.spawn` — both impls would receive the
  // same call shape, but the latter would silently break npm-
  // installed copilot on Windows. The single-line identity test
  // immediately below is what pins that.

  it("defaultSpawnImpl is bound to cross-spawn (npm-installed copilot regression pin)", () => {
    // If this assertion ever flips, every other test in this file
    // can still pass while production silently breaks for any user
    // with `copilot.cmd` rather than `copilot.exe` on PATH.
    // Cross-spawn is the ONLY supported way to spawn `.cmd` files
    // on Node 18.20+/20.12+ (CVE-2024-27980 mitigation), so the
    // identity check IS the contract.
    expect(defaultSpawnImpl).toBe(crossSpawn);
  });

  it("hands the bare bin name to the spawn impl unchanged (cross-spawn handles platform quirks)", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "say hi", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        // Bare name. Production goes through cross-spawn which
        // does PATH lookup + PATHEXT + .cmd wrap on Windows; tests
        // stub at the same seam so the call shape stays uniform.
        copilotBin: "copilot",
      },
    );
    expect(fake.captures?.command).toBe("copilot");
    const args = fake.captures?.args ?? [];
    // Args reach the spawn impl untouched — no manual cmd.exe
    // wrap, no escapeCmdArg quoting, no windowsVerbatimArguments.
    // Cross-spawn (production) or the test fake will see the same
    // shape; cross-spawn rewrites internally, the fake captures
    // verbatim.
    expect(args).toContain("say hi");
    expect(args).toContain("--allow-all");
    expect(args).toContain("--no-ask-user");
    const opts = fake.captures?.options as { windowsVerbatimArguments?: boolean };
    expect(opts.windowsVerbatimArguments).toBeFalsy();
  });

  it("forwards an explicit copilotBin path verbatim (no resolver layer mangles it)", async () => {
    // Removed in this PR: a `resolveCopilotBin` indirection that
    // tried to swap WinGet shim paths. Production now requires npm-
    // installed copilot (`npm install -g @github/copilot`); the
    // launcher hands the configured `copilotBin` straight through
    // to the spawn impl. This test pins that no-mangling contract.
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        copilotBin: "/opt/local/bin/copilot",
      },
    );
    expect(fake.captures?.command).toBe("/opt/local/bin/copilot");
  });

  it("does not pass an env override to spawn when subprocessEnv is unset (Node default-inherit)", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
      },
    );
    const opts = fake.captures?.options as { env?: NodeJS.ProcessEnv };
    expect(opts.env).toBeUndefined();
  });

  it("merges subprocessEnv on top of process.env so children inherit context bag", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    await launchCopilotHeadless(
      {
        taskDir,
        agent,
        catalog,
        prompt: "x",
        workspaceDir: scratch,
        subprocessEnv: {
          EMPLOKE_WORKSPACE: "ws-uuid-1",
          EMPLOKE_RUN_ID: "01HZZZ",
          EMPLOKE_SERVER: "http://127.0.0.1:8787",
        },
      },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
      },
    );
    const opts = fake.captures?.options as { env: NodeJS.ProcessEnv };
    expect(opts.env.EMPLOKE_WORKSPACE).toBe("ws-uuid-1");
    expect(opts.env.EMPLOKE_RUN_ID).toBe("01HZZZ");
    expect(opts.env.EMPLOKE_SERVER).toBe("http://127.0.0.1:8787");
    // PATH (or similar) from process.env is still there — we layered, didn't replace.
    expect(opts.env.PATH ?? opts.env.Path).toBeDefined();
  });

  it("subprocessEnv overrides win over process.env (per-task identity beats inherited)", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    const original = process.env.EMPLOKE_WORKSPACE;
    process.env.EMPLOKE_WORKSPACE = "stale-ambient";
    try {
      await launchCopilotHeadless(
        {
          taskDir,
          agent,
          catalog,
          prompt: "x",
          workspaceDir: scratch,
          subprocessEnv: { EMPLOKE_WORKSPACE: "fresh-from-dispatch" },
        },
        {
          copilotStateDir: stateDir,
          sharedDir: scratch,
          randomUUID: () => FIXED_UUID,
          spawn: fake.spawn,
        },
      );
      const opts = fake.captures?.options as { env: NodeJS.ProcessEnv };
      expect(opts.env.EMPLOKE_WORKSPACE).toBe("fresh-from-dispatch");
    } finally {
      if (original === undefined) delete process.env.EMPLOKE_WORKSPACE;
      else process.env.EMPLOKE_WORKSPACE = original;
    }
  });

  it("subprocessEnv with explicit `undefined` deletes the inherited variable", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    const original = process.env.EMPLOKE_LEGACY_VAR;
    process.env.EMPLOKE_LEGACY_VAR = "leaked-from-server-env";
    try {
      await launchCopilotHeadless(
        {
          taskDir,
          agent,
          catalog,
          prompt: "x",
          workspaceDir: scratch,
          // Caller wants the inherited variable explicitly suppressed
          // — passing `undefined` rather than branching on whether the
          // value is set upstream. mergeEnv must drop the entry
          // entirely so the child sees `process.env.X === undefined`
          // rather than the literal string "undefined".
          subprocessEnv: { EMPLOKE_LEGACY_VAR: undefined },
        },
        {
          copilotStateDir: stateDir,
          sharedDir: scratch,
          randomUUID: () => FIXED_UUID,
          spawn: fake.spawn,
        },
      );
      const opts = fake.captures?.options as { env: NodeJS.ProcessEnv };
      expect(opts.env.EMPLOKE_LEGACY_VAR).toBeUndefined();
      expect("EMPLOKE_LEGACY_VAR" in opts.env).toBe(false);
    } finally {
      if (original === undefined) delete process.env.EMPLOKE_LEGACY_VAR;
      else process.env.EMPLOKE_LEGACY_VAR = original;
    }
  });

  it("returns a handle exposing pid and runtimeSessionId", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    const handle = await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
      },
    );
    expect(handle.pid).toBe(12345);
    expect(handle.runtimeSessionId).toBe(FIXED_UUID);
  });

  it("exit promise resolves with code+signal=null on clean exit", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    const handle = await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
      },
    );
    setImmediate(() => fake.child.emit("exit", 0, null));
    await expect(handle.exit).resolves.toEqual({ code: 0, signal: null });
  });

  it("exit promise carries the non-zero exit code", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    const handle = await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
      },
    );
    setImmediate(() => fake.child.emit("exit", 42, null));
    await expect(handle.exit).resolves.toEqual({ code: 42, signal: null });
  });

  it("exit promise carries the termination signal", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    const handle = await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
      },
    );
    setImmediate(() => fake.child.emit("exit", null, "SIGTERM"));
    await expect(handle.exit).resolves.toEqual({ code: null, signal: "SIGTERM" });
  });

  it("kill() forwards to child.kill", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    const handle = await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
      },
    );
    handle.kill();
    expect(fake.child.killCalls).toBe(1);
  });

  it("kill() swallows errors from already-dead processes", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    fake.child.killImpl = () => {
      throw new Error("ESRCH");
    };
    const handle = await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
      },
    );
    expect(() => handle.kill()).not.toThrow();
  });

  it("rejects with RuntimeHeadlessLaunchFailed when 'error' fires before 'spawn'", async () => {
    const { agent, catalog } = await buildAgent();
    const child = new FakeChild();
    const spawn: SpawnFn = (() => {
      queueMicrotask(() => child.emit("error", new Error("ENOENT: copilot not found")));
      return child as unknown as ReturnType<SpawnFn>;
    }) as SpawnFn;
    await expect(
      launchCopilotHeadless(
        { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
        {
          copilotStateDir: stateDir,
          sharedDir: scratch,
          randomUUID: () => FIXED_UUID,
          spawn,
        },
      ),
    ).rejects.toBeInstanceOf(RuntimeHeadlessLaunchFailed);
  });

  // Belt-and-suspenders deadlock guard: if a child process is returned but
  // the runtime never gets a `spawn` or `error` event (Node v15+ docs say
  // this can't happen, but we don't trust theory to keep a task from
  // wedging the manager), the dispatch must reject within the configured
  // timeout and best-effort kill the lingering child so we don't leak
  // orphans behind the rejected promise. Tests inject a tiny timeout so
  // they don't actually wait 30s.
  it("rejects with RuntimeHeadlessLaunchFailed when neither 'spawn' nor 'error' fires within the timeout", async () => {
    const { agent, catalog } = await buildAgent();
    const child = new FakeChild();
    const spawn: SpawnFn = (() => {
      // Intentionally never emit 'spawn' or 'error'.
      return child as unknown as ReturnType<SpawnFn>;
    }) as SpawnFn;
    const promise = launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn,
        spawnTimeoutMs: 50,
      },
    );
    await expect(promise).rejects.toBeInstanceOf(RuntimeHeadlessLaunchFailed);
    // Sanitised wrapper message (#24) carries only the runtime kind;
    // the underlying `timed out after Nms` string lives on `cause`.
    await expect(promise).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/timed out after 50ms/) }),
    });
    // Lingering child should have been killed to prevent leaks.
    expect(child.killCalls).toBeGreaterThanOrEqual(1);
  });

  it("wraps provision failures as RuntimeProvisionFailed", async () => {
    const badAgent: AgentResolveResult = {
      agent: { name: "missing", description: "x", version: "0.0.1" },
      agentPath: path.join(scratch, "definitely-not-here"),
      skills: [],
      mcps: [],
    };
    const fake = makeFakeSpawn();
    await expect(
      launchCopilotHeadless(
        {
          taskDir,
          agent: badAgent,
          // biome-ignore lint/suspicious/noExplicitAny: this test exercises provision's badAgent path; catalog is unused on that codepath
          catalog: undefined as any,
          prompt: "x",
          workspaceDir: scratch,
        },
        {
          copilotStateDir: stateDir,
          sharedDir: scratch,
          randomUUID: () => FIXED_UUID,
          spawn: fake.spawn,
        },
      ),
    ).rejects.toBeInstanceOf(RuntimeProvisionFailed);
  });

  it("wraps mkdir failures on the session dir as RuntimeHeadlessLaunchFailed", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    const failingMkdir = (async () => {
      throw new Error("EACCES: mock");
    }) as unknown as typeof mkdir;
    await expect(
      launchCopilotHeadless(
        { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
        {
          copilotStateDir: stateDir,
          sharedDir: scratch,
          randomUUID: () => FIXED_UUID,
          spawn: fake.spawn,
          mkdir: failingMkdir,
        },
      ),
    ).rejects.toBeInstanceOf(RuntimeHeadlessLaunchFailed);
  });

  it("mirrors child stderr to <taskDir>/stderr.log", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    const handle = await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
      },
    );
    fake.child.stderr.push(Buffer.from("warn: something\n"));
    fake.child.stderr.push(null);
    fake.child.stdout.push(null);
    setImmediate(() => fake.child.emit("exit", 0, null));
    await handle.exit;
    await new Promise((r) => setTimeout(r, 20));
    const content = await readFile(path.join(taskDir, COPILOT_STDERR_LOG), "utf8");
    expect(content).toContain("warn: something");
  });

  it("mirrors child stdout to <taskDir>/stdout.log", async () => {
    // Stdout is piped (not 'ignore') so the child's `process.stdout`
    // flush has a real file handle on Windows, where 'ignore' â†’
    // NUL â†’ FlushFileBuffers fails with "Incorrect function." We
    // assert both that the file is created and that pushed bytes
    // land in it.
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    const handle = await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
      },
    );
    fake.child.stdout.push(Buffer.from('{"event":"start"}\n'));
    fake.child.stdout.push(null);
    fake.child.stderr.push(null);
    setImmediate(() => fake.child.emit("exit", 0, null));
    await handle.exit;
    await new Promise((r) => setTimeout(r, 20));
    const content = await readFile(path.join(taskDir, COPILOT_STDOUT_LOG), "utf8");
    expect(content).toContain('{"event":"start"}');
  });

  // The child's stdout/stderr streams + the disk write streams + the
  // child process itself all emit `error` events. `pipe()` does NOT
  // forward them, and an unhandled `error` on a `Writable` /
  // `EventEmitter` throws in the host process. Without listeners, a full
  // disk during a long-running task would crash the manager. The
  // listeners we attach swallow the error (best-effort: degrade to "no
  // captured output" rather than die). This test fires a synthetic error
  // on each surface and asserts the manager's exit promise still
  // resolves cleanly.
  it("survives errors on child streams and child itself without crashing", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    const handle = await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        sharedDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
      },
    );

    // Fire errors on every surface listed in the JSDoc. If any of these
    // bubble up to the unhandled-error handler, vitest will surface
    // them as test failures.
    fake.child.stdout.emit("error", new Error("ENOSPC: disk full"));
    fake.child.stderr.emit("error", new Error("EPIPE"));
    fake.child.emit("error", new Error("late child error"));

    // The synthetic child-side error should still settle the exit
    // promise (per the JSDoc â€” we synthesise a {code:null, signal:null}
    // exit so the manager doesn't hang).
    const result = await handle.exit;
    expect(result).toEqual({ code: null, signal: null });
  });
});

// Pure-function smoke tests for the argv builder. The launcher tests
// above already exercise both branches end-to-end via the live
// `existsSync` probe; these direct tests pin the contract of the
// helper itself so a future caller (e.g. another runtime adapter
// reusing the flag set) can rely on a stable shape without spinning
// up the full launch machinery.
describe("buildCopilotHeadlessArgs", () => {
  it("returns the base argv when mcpConfigExists=false", () => {
    const args = buildCopilotHeadlessArgs({
      prompt: "p",
      runtimeSessionId: "rid-123",
      taskDir: "/abs/task",
      mcpConfigExists: false,
    });
    expect(args).toEqual([
      "-p",
      "p",
      "--resume",
      "rid-123",
      "--allow-all",
      "--no-ask-user",
      "--output-format",
      "json",
      "-C",
      "/abs/task",
    ]);
  });

  it("appends the two-argv --additional-mcp-config pair when mcpConfigExists=true", () => {
    const args = buildCopilotHeadlessArgs({
      prompt: "p",
      runtimeSessionId: "rid-123",
      taskDir: "/abs/task",
      mcpConfigExists: true,
    });
    // Tail-appended so prefix-sensitive consumers (none today, but
    // the contract is "stable prefix + optional flags after `-C`")
    // keep working.
    expect(args.slice(-2)).toEqual(["--additional-mcp-config", "@./.mcp.json"]);
    expect(args.length).toBe(12);
  });

  it("does not mutate inputs and returns a fresh array each call", () => {
    const opts = {
      prompt: "p",
      runtimeSessionId: "rid",
      taskDir: "/t",
      mcpConfigExists: true,
    } as const;
    const a = buildCopilotHeadlessArgs(opts);
    const b = buildCopilotHeadlessArgs(opts);
    expect(a).toEqual(b);
    expect(a).not.toBe(b); // distinct array instances
  });
});
