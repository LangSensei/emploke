import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnFn } from "../../src/copilot/launch-headless.js";
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

/**
 * Default-deps shape that suppresses the WinGet-shim resolver. Tests
 * want deterministic command resolution; the resolver kicks in on
 * Windows and would otherwise rewrite "copilot" to a full WinGet path
 * found on the test machine.
 */
const NOOP_RESOLVE_BIN = {
  platform: "linux" as NodeJS.Platform,
};

describe("launchCopilotHeadless", () => {
  it("provisions the workdir before spawning", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "hello", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        globalDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        resolveBin: NOOP_RESOLVE_BIN,
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
        globalDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        resolveBin: NOOP_RESOLVE_BIN,
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
        globalDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        resolveBin: NOOP_RESOLVE_BIN,
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

  it("honours an injected copilotBin override", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        globalDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        copilotBin: "C:\\fake\\copilot.exe",
      },
    );
    expect(fake.captures?.command).toBe("C:\\fake\\copilot.exe");
  });

  // CVE-2024-27980 mitigation: Node 18.20.0+ / 20.12.0+ refuses to
  // spawn `.cmd` / `.bat` files directly (EINVAL) to prevent
  // arg-injection attacks. We wrap such bins via `cmd.exe /d /s /c`
  // with explicit `escapeCmdArg` quoting so the supported escape
  // hatch (`shell: true`) doesn't introduce a different injection
  // surface. The wrap is windows-only — POSIX paths take the
  // direct-spawn branch.
  describe.skipIf(process.platform !== "win32")("cmd.exe wrap (Windows .cmd / .bat)", () => {
    it("wraps `.cmd` bin via cmd.exe /d /s /c with escaped argv (CVE-2024-27980 mitigation)", async () => {
      const { agent, catalog } = await buildAgent();
      const fake = makeFakeSpawn();
      const cmdShim = "C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd";
      await launchCopilotHeadless(
        { taskDir, agent, catalog, prompt: "say hi", workspaceDir: scratch },
        {
          copilotStateDir: stateDir,
          globalDir: scratch,
          randomUUID: () => FIXED_UUID,
          spawn: fake.spawn,
          copilotBin: cmdShim,
        },
      );
      expect(fake.captures?.command).toBe("cmd.exe");
      const args = fake.captures?.args ?? [];
      expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      // The fourth arg is a single string holding the WHOLE escaped
      // command line, wrapped in extra outer quotes so cmd /S's
      // "strip-first-and-last-quote" rule leaves the inner sequence
      // correctly quoted (per cmd /? semantics). Without the outer
      // wrap, cmd would strip the first and last quotes of our
      // escaped sequence and try to execute the inner blob as a
      // single command name, hitting "is not recognized as an
      // internal or external command".
      const wrapped = args[3] as string;
      expect(wrapped.startsWith('""')).toBe(true);
      expect(wrapped.endsWith('""')).toBe(true);
      // Bin and the user-supplied prompt arg are both inside the
      // wrapped string, each individually quoted via escapeCmdArg.
      expect(wrapped).toContain('"C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd"');
      expect(wrapped).toContain('"say hi"');
      // windowsVerbatimArguments must be true alongside this shape;
      // otherwise libuv re-quotes our argv and breaks the carefully
      // assembled command line.
      const opts = fake.captures?.options as { windowsVerbatimArguments: boolean };
      expect(opts.windowsVerbatimArguments).toBe(true);
    });

    it("escapes shell metachars in args so they cannot break out of the cmd.exe wrap", async () => {
      const { agent, catalog } = await buildAgent();
      const fake = makeFakeSpawn();
      const cmdShim = "C:\\nodejs\\copilot.cmd";
      await launchCopilotHeadless(
        {
          taskDir,
          agent,
          catalog,
          // Prompt with every cmd.exe metachar that escapeCmdArg defends:
          // `&`, `|`, `<`, `>`, `^`, `(`, `)`, `%`, `!`, `"`.
          prompt: 'say & hi | tee out.log > nul < in.txt ^ cat (a) %FOO% !BAR! "quoted"',
          workspaceDir: scratch,
        },
        {
          copilotStateDir: stateDir,
          globalDir: scratch,
          randomUUID: () => FIXED_UUID,
          spawn: fake.spawn,
          copilotBin: cmdShim,
        },
      );
      const wrapped = (fake.captures?.args ?? [])[3] as string;
      // Each metachar appears caret-escaped inside its argument's
      // quoted region. Defense-in-depth assertion: NO unescaped
      // metachar reaches cmd.exe's parser (which would let it
      // break out and execute additional commands).
      expect(wrapped).toContain("^&");
      expect(wrapped).toContain("^|");
      expect(wrapped).toContain("^<");
      expect(wrapped).toContain("^>");
      expect(wrapped).toContain("^^");
      expect(wrapped).toContain("^(");
      expect(wrapped).toContain("^)");
      expect(wrapped).toContain("^%");
      expect(wrapped).toContain("^!");
      expect(wrapped).toContain('^"');
    });

    it("takes the direct-spawn branch for .exe (no wrap needed)", async () => {
      const { agent, catalog } = await buildAgent();
      const fake = makeFakeSpawn();
      await launchCopilotHeadless(
        { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
        {
          copilotStateDir: stateDir,
          globalDir: scratch,
          randomUUID: () => FIXED_UUID,
          spawn: fake.spawn,
          copilotBin: "C:\\winget\\copilot.exe",
        },
      );
      // Direct spawn: command IS the bin (not cmd.exe).
      expect(fake.captures?.command).toBe("C:\\winget\\copilot.exe");
      const opts = fake.captures?.options as { windowsVerbatimArguments?: boolean };
      // No verbatim flag on the direct path — libuv's standard
      // MSVCRT-style escaping handles argv naturally.
      expect(opts.windowsVerbatimArguments).toBeFalsy();
    });
  });

  it("does not pass an env override to spawn when subprocessEnv is unset (Node default-inherit)", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        globalDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        resolveBin: NOOP_RESOLVE_BIN,
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
          EMPLOKE_TASK_ID: "01HZZZ",
          EMPLOKE_SERVER: "http://127.0.0.1:8787",
        },
      },
      {
        copilotStateDir: stateDir,
        globalDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        resolveBin: NOOP_RESOLVE_BIN,
      },
    );
    const opts = fake.captures?.options as { env: NodeJS.ProcessEnv };
    expect(opts.env.EMPLOKE_WORKSPACE).toBe("ws-uuid-1");
    expect(opts.env.EMPLOKE_TASK_ID).toBe("01HZZZ");
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
          globalDir: scratch,
          randomUUID: () => FIXED_UUID,
          spawn: fake.spawn,
          resolveBin: NOOP_RESOLVE_BIN,
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
    const original = process.env.EMPLOKE_API_KEY;
    process.env.EMPLOKE_API_KEY = "leaked-from-server-env";
    try {
      await launchCopilotHeadless(
        {
          taskDir,
          agent,
          catalog,
          prompt: "x",
          workspaceDir: scratch,
          // Server has no API key configured — caller passes
          // `undefined` rather than branching on whether the key is
          // set upstream. mergeEnv must drop the entry entirely so
          // the child sees `process.env.EMPLOKE_API_KEY === undefined`
          // rather than the literal string "undefined".
          subprocessEnv: { EMPLOKE_API_KEY: undefined },
        },
        {
          copilotStateDir: stateDir,
          globalDir: scratch,
          randomUUID: () => FIXED_UUID,
          spawn: fake.spawn,
          resolveBin: NOOP_RESOLVE_BIN,
        },
      );
      const opts = fake.captures?.options as { env: NodeJS.ProcessEnv };
      expect(opts.env.EMPLOKE_API_KEY).toBeUndefined();
      expect("EMPLOKE_API_KEY" in opts.env).toBe(false);
    } finally {
      if (original === undefined) delete process.env.EMPLOKE_API_KEY;
      else process.env.EMPLOKE_API_KEY = original;
    }
  });

  it("returns a handle exposing pid and runtimeSessionId", async () => {
    const { agent, catalog } = await buildAgent();
    const fake = makeFakeSpawn();
    const handle = await launchCopilotHeadless(
      { taskDir, agent, catalog, prompt: "x", workspaceDir: scratch },
      {
        copilotStateDir: stateDir,
        globalDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        resolveBin: NOOP_RESOLVE_BIN,
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
        globalDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        resolveBin: NOOP_RESOLVE_BIN,
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
        globalDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        resolveBin: NOOP_RESOLVE_BIN,
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
        globalDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        resolveBin: NOOP_RESOLVE_BIN,
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
        globalDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        resolveBin: NOOP_RESOLVE_BIN,
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
        globalDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        resolveBin: NOOP_RESOLVE_BIN,
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
          globalDir: scratch,
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
        globalDir: scratch,
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
          globalDir: scratch,
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
          globalDir: scratch,
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
        globalDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        resolveBin: NOOP_RESOLVE_BIN,
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
        globalDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        resolveBin: NOOP_RESOLVE_BIN,
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
        globalDir: scratch,
        randomUUID: () => FIXED_UUID,
        spawn: fake.spawn,
        resolveBin: NOOP_RESOLVE_BIN,
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
