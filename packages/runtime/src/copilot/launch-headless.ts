import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir as nodeMkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";
import crossSpawn from "cross-spawn";
import { RuntimeHeadlessLaunchFailed, RuntimeProvisionFailed } from "../errors.js";
import type { PlaceholderContext } from "../placeholders.js";
import type { RuntimeExit, RuntimeHandle } from "../types.js";
import { generateCopilotSessionId } from "./ids.js";
import { provisionCopilotWorkdir } from "./provision.js";

/**
 * File names for side-channel stdout/stderr capture under the task
 * directory. Copilot's primary log surface is `events.jsonl` inside the
 * per-session state dir at `<copilotStateDir>/<runtimeSessionId>/`,
 * which the runtime owns end-to-end via `Runtime.readActivity`. These
 * files exist as a fallback for output that happens before the session
 * dir has anything useful (e.g. the CLI complaining about a missing
 * flag) and — crucially on Windows — to give the child process a real
 * file handle as its stdout. Without that, `'ignore'` resolves to the
 * NUL device, and any subsequent `process.stdout` flush from the child
 * aborts with `Failed to sync '<stdout>': Incorrect function.` because
 * Windows' NUL doesn't support `FlushFileBuffers`. Real files do.
 */
export const COPILOT_STDOUT_LOG = "stdout.log";
export const COPILOT_STDERR_LOG = "stderr.log";

/**
 * Default spawn implementation used when `LaunchCopilotHeadlessDeps.spawn`
 * is not injected (i.e. production code paths). Wraps `cross-spawn` so
 * Windows footguns (PATHEXT iteration, `.cmd`/`.bat` execution post
 * CVE-2024-27980, `cmd /S` quote-stripping) are handled transparently.
 *
 * Exported so a regression test can assert `defaultSpawnImpl ===
 * crossSpawn`. Without that pin, a future maintainer could swap the
 * fallback at line 250 from `crossSpawn` back to `node:child_process`'s
 * native `spawn` — every existing unit test would still pass (they
 * inject a fake at the same seam), but production would silently
 * break for any user with an npm-installed copilot on Windows. See
 * `launch-headless.test.ts` for the assertion that pins this.
 */
export const defaultSpawnImpl: SpawnFn = crossSpawn as unknown as SpawnFn;

/**
 * Merge a base env (typically `process.env`) with an override map,
 * deleting any key whose override value is `undefined`. Returns a fresh
 * object so callers can hand it straight to `child_process.spawn` without
 * mutating the caller's env.
 *
 * Why bother: Node's spawn semantics interpret `undefined` values in
 * `env` as "actually set the variable to the literal string 'undefined'"
 * on some platforms (the value goes through a `String()` conversion).
 * That's almost never what the caller wants when they pass
 * `EMPLOKE_HOME: process.env.EMPLOKE_HOME` and the upstream env
 * has no value set. Stripping `undefined` before spawn means downstream
 * `process.env.EMPLOKE_HOME` is genuinely `undefined` rather than
 * the string "undefined". The same convention is used by every
 * `process.env`-aware helper we've built so the runtime stays
 * predictable across platforms.
 */
function mergeEnv(base: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete out[key];
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Default child_process.spawn signature, narrowed to what we actually call.
 * Carved out as a type alias so the test seam parameter can be typed
 * without leaking node's overload soup into the public surface.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof nodeSpawn>[2],
) => ChildProcess;

export interface LaunchCopilotHeadlessDeps {
  /**
   * Root under which Copilot maintains per-session state directories. We
   * `mkdir` `<copilotStateDir>/<sessionId>/` before spawn so the returned
   * `sessionDir` resolves to a path that already exists, avoiding a
   * race against Copilot's first event write — useful for callers (and
   * tests) that need a stable path post-launch even before the CLI
   * has had a chance to write anything. The runtime then reads back
   * from this dir via `readActivity` whenever the dashboard asks for
   * the parsed timeline.
   */
  readonly copilotStateDir: string;
  /**
   * Absolute path resolved as `${sharedDir}` during provision-time
   * placeholder substitution in MCP specs. Required so non-interactive
   * task launch reaches the same per-machine shared dir as interactive
   * provision; the copilot runtime threads the value from
   * `CopilotRuntimeConfig.sharedDir`.
   */
  readonly sharedDir: string;
  /** Path to the `copilot` executable. Defaults to bare `"copilot"` (PATH lookup via cross-spawn). */
  readonly copilotBin?: string;
  /** Test seam for id generation. */
  readonly randomUUID?: () => string;
  /** Test seam for spawn. */
  readonly spawn?: SpawnFn;
  /** Test seam for mkdir. */
  readonly mkdir?: typeof nodeMkdir;
  /**
   * Maximum time to wait for the child's `'spawn'` (or `'error'`) event
   * before giving up and reporting `RuntimeHeadlessLaunchFailed`. Defaults
   * to 30000 ms.
   *
   * The cap exists purely as a deadlock guard: Node v15+ documents that
   * `spawn` and `error` are guaranteed to fire one or the other, so in
   * practice this never trips. We keep it because the failure mode if
   * it ever did fire-neither (Node bug, OS-level wedge) would be a
   * task that hangs `running` forever with no exit watcher attached.
   *
   * 30s leaves enough headroom for the worst real-world cases observed
   * on Windows — Defender / EDR can hold a `CreateProcess` for several
   * seconds while it scans a large unfamiliar `.exe` (Copilot ships as
   * a tens-of-MB packaged Node binary) — without making true deadlocks
   * pin the manager indefinitely.
   *
   * Tests inject a small value (e.g. 50 ms) to avoid actually waiting.
   */
  readonly spawnTimeoutMs?: number;
}

export interface LaunchCopilotHeadlessOpts {
  readonly taskDir: string;
  readonly agent: AgentResolveResult;
  readonly catalog: CatalogManager;
  readonly prompt: string;
  /**
   * Absolute path of the workspace this task lives under. Forwarded to
   * `provisionCopilotWorkdir` as `${workspaceDir}` for placeholder
   * substitution in MCP specs.
   */
  readonly workspaceDir: string;
  /**
   * Optional bag merged into the spawned subprocess's environment on
   * top of `process.env`. See `LaunchHeadlessOpts.subprocessEnv` for
   * the rationale (TL;DR: lets emploke-controlled children inherit
   * `EMPLOKE_WORKSPACE` etc. without the AI-agent caller having to
   * `export` per-shell).
   */
  readonly subprocessEnv?: NodeJS.ProcessEnv;
}

/**
 * Spawn `copilot -p <prompt> --resume=<uuid>` against `taskDir` and return
 * a live {@link RuntimeHandle}. The CLI runs unattended (`--allow-all`,
 * `--no-ask-user`) and emits structured events into its per-session state
 * directory, which the caller can mount under the task workdir.
 *
 * Sequence:
 *   1. Provision the workdir (AGENTS.md, .mcp.json, .github/skills, …) the
 *      same way `provision()` does for an interactive session. Wraps the
 *      failure as `RuntimeProvisionFailed` so callers can distinguish
 *      provisioning trouble from spawn trouble.
 *   2. Mint a fresh Copilot session id and pre-create
 *      `<copilotStateDir>/<id>/` so the returned `sessionDir` resolves to
 *      a path that already exists (consumers can read it via
 *      `Runtime.readActivity` immediately, no race with Copilot's
 *      first event write).
 *   3. Spawn the CLI in non-interactive mode with stdout/stderr piped to
 *      `<taskDir>/stdout.log` and `<taskDir>/stderr.log` respectively.
 *      The canonical log lives in events.jsonl under the session dir;
 *      these files mostly catch CLI-level diagnostics and exist
 *      primarily to give the child a real file handle for stdout, which
 *      Windows requires for `process.stdout` flushing to succeed.
 *   4. Wait for the `'spawn'` event to confirm the OS started the
 *      process. Spawn failures (ENOENT on `copilot`, EPERM, …) reject the
 *      launchHeadless promise with `RuntimeHeadlessLaunchFailed`. Once spawn is
 *      confirmed, post-startup failures become normal task outcomes
 *      surfaced via `handle.exit`.
 */
export async function launchCopilotHeadless(
  opts: LaunchCopilotHeadlessOpts,
  deps: LaunchCopilotHeadlessDeps,
): Promise<RuntimeHandle> {
  // Step 1: provision. Distinguishable from spawn failures via error type.
  const placeholders: PlaceholderContext = {
    workspaceDir: opts.workspaceDir,
    sharedDir: deps.sharedDir,
  };
  try {
    await provisionCopilotWorkdir(opts.taskDir, opts.agent, opts.catalog, placeholders);
  } catch (cause) {
    throw new RuntimeProvisionFailed("copilot", opts.taskDir, cause as Error);
  }

  const mkdirImpl = deps.mkdir ?? nodeMkdir;
  // Bin path. Default `"copilot"`; cross-spawn at the spawn site
  // handles PATH lookup, PATHEXT iteration (Windows), and the
  // `.cmd` / `.bat` cmd.exe wrap (CVE-2024-27980 mitigation).
  // Production users should `npm install -g @github/copilot`; the
  // WinGet-installed Copilot has a separate stdout-corruption bug
  // under non-console spawn that emploke does not work around.
  const bin = deps.copilotBin ?? "copilot";

  // Step 2: pre-allocate session id + dir.
  let sessionId: string;
  let sessionDir: string;
  try {
    sessionId = generateCopilotSessionId(deps.randomUUID);
    sessionDir = path.join(deps.copilotStateDir, sessionId);
    await mkdirImpl(sessionDir, { recursive: true });
  } catch (cause) {
    throw new RuntimeHeadlessLaunchFailed("copilot", opts.taskDir, cause as Error);
  }

  // Step 3: spawn.
  // `--allow-all` is required for non-interactive mode (per copilot --help)
  // and unblocks tool/path/url confirmation prompts. `--no-ask-user`
  // disables the ask_user tool so the agent can't pause waiting for input
  // we'll never deliver. `--output-format json` makes stdout a JSONL of
  // events. We don't currently consume that stream — the canonical event
  // log lives at `<sessionDir>/events.jsonl` and the dashboard reads it
  // through the runtime's `readActivity` surface — but the flag stays
  // on so a future progress-streaming UI can attach to stdout without
  // changing the spawn arguments. `-C` is redundant with `cwd` but
  // belt-and-suspenders for tools that introspect argv.
  const args = [
    "-p",
    opts.prompt,
    "--resume",
    sessionId,
    "--allow-all",
    "--no-ask-user",
    "--output-format",
    "json",
    "-C",
    opts.taskDir,
  ];

  let child: ChildProcess;
  try {
    // Spawn via `cross-spawn`, the npm de-facto standard for "spawn a
    // child cross-platform without surprises" (100M+ weekly downloads,
    // used by npm CLI / Jest / Mocha / ESLint). It transparently
    // handles every Windows-spawn footgun that this codebase used to
    // patch by hand:
    //
    //   - Bare-name PATHEXT iteration: spawn("copilot", ...) finds
    //     `copilot.cmd` even though Node's CreateProcess won't.
    //   - .cmd / .bat execution post CVE-2024-27980 (Node 18.20.0+ /
    //     20.12.0+): cross-spawn wraps with cmd.exe internally using
    //     the same `windowsVerbatimArguments` + escape pattern we
    //     used to write by hand, plus the cmd /S quote-stripping
    //     workaround that takes an extra outer pair of quotes so
    //     cmd parses the inner sequence correctly.
    //   - Shebang resolution for #!-line scripts (irrelevant for
    //     copilot but keeps the contract simple).
    //
    // The test seam (`deps.spawn`) lets unit tests inject a fake
    // SpawnFn — used by `launch-headless.test.ts` to capture and
    // assert on spawn args without actually launching a child.
    // Production goes through `defaultSpawnImpl` (cross-spawn); the
    // seam never sees it. The default impl is exported above so
    // a one-line regression test can assert it stays bound to
    // cross-spawn — see the comment on `defaultSpawnImpl` for why.
    const spawnImpl = deps.spawn ?? defaultSpawnImpl;
    child = spawnImpl(bin, args, {
      cwd: opts.taskDir,
      // stdout/stderr both piped — we mirror to stdout.log/stderr.log.
      // 'ignore' would map stdout to NUL on Windows, which doesn't
      // support FlushFileBuffers; the child process then aborts with
      // "Failed to sync '<stdout>': Incorrect function." before any
      // real work happens. Piping gives it a real handle.
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      windowsHide: true,
      // Inherit the server's env so PATH / HOME / Copilot's own auth
      // tokens etc. flow through, then layer the per-task bag on top.
      // We omit the field entirely when no override is supplied, so
      // Node's default-inherit behaviour kicks in.
      env: opts.subprocessEnv ? mergeEnv(process.env, opts.subprocessEnv) : undefined,
    });
  } catch (cause) {
    // Truly synchronous spawn failure. Rare on Node; usually async via 'error'.
    throw new RuntimeHeadlessLaunchFailed("copilot", opts.taskDir, cause as Error);
  }

  // Step 4: await `'spawn'` so a failed exec (ENOENT, EPERM) surfaces
  // synchronously to the caller instead of via a never-resolving exit
  // promise. Without this guard a missing `copilot` binary would silently
  // park the task in `running` forever.
  //
  // The timeout is a deadlock guard, not a "spawn must finish quickly"
  // policy — it caps the wait if neither `spawn` nor `error` ever fires
  // (Node v15+ guarantees one will, but we don't want a Node bug to
  // wedge a task forever). See `spawnTimeoutMs` deps doc for sizing
  // rationale.
  const spawnTimeoutMs = deps.spawnTimeoutMs ?? 30_000;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Best-effort kill the maybe-running child so we don't leak a
      // process behind the rejected promise. If it never spawned this
      // is a no-op; if it did spawn but missed the event, the kill
      // tears it down.
      try {
        child.kill();
      } catch {
        // Already gone or never started.
      }
      reject(
        new RuntimeHeadlessLaunchFailed(
          "copilot",
          opts.taskDir,
          new Error(
            `timed out after ${spawnTimeoutMs}ms waiting for child 'spawn' or 'error' event`,
          ),
        ),
      );
    }, spawnTimeoutMs);
    timer.unref();
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new RuntimeHeadlessLaunchFailed("copilot", opts.taskDir, err));
    });
  });

  // Pipe stdout/stderr to disk. Append-mode so a re-launch (future
  // feature) wouldn't truncate prior context, but in MVP each task dir
  // is fresh. Stdout *must* be a real file (not 'ignore'/NUL) for
  // Windows: the child's `process.stdout` flush calls FlushFileBuffers,
  // which fails on NUL with ERROR_INVALID_FUNCTION ("Incorrect
  // function") and aborts the child before any real work happens.
  const stdoutPath = path.join(opts.taskDir, COPILOT_STDOUT_LOG);
  const stderrPath = path.join(opts.taskDir, COPILOT_STDERR_LOG);
  let stdoutStream: WriteStream | null = null;
  let stderrStream: WriteStream | null = null;
  if (child.stdout !== null) {
    stdoutStream = createWriteStream(stdoutPath, { flags: "a" });
    // `pipe()` does NOT forward source-side errors to the destination,
    // and on a `Writable` an unhandled `error` event throws in the
    // process. Trigger surfaces: `ENOSPC`/`EROFS` on the log volume,
    // permission flips, file system unmount mid-task. Swallow log-stream
    // errors so a full disk degrades to "no captured output" rather than
    // killing the manager process. The exit watcher still runs and the
    // task still completes from the OS's point of view.
    stdoutStream.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stdout.pipe(stdoutStream);
  }
  if (child.stderr !== null) {
    stderrStream = createWriteStream(stderrPath, { flags: "a" });
    stderrStream.on("error", () => {});
    child.stderr.on("error", () => {});
    child.stderr.pipe(stderrStream);
  }

  // Build the exit promise. Closes the log streams on exit so file
  // descriptors don't linger.
  //
  // Note on the post-spawn `child.on("error", ...)`: the pre-spawn
  // listener (Step 4 above) is removed once the spawn|error race
  // settles, so without this the child process emitting a late `error`
  // event (failed `kill`, IPC issue, …) would crash the manager. We
  // route it into the exit promise so the watcher still settles
  // deterministically.
  const exit = new Promise<RuntimeExit>((resolve) => {
    let settled = false;
    const settle = (info: RuntimeExit) => {
      if (settled) return;
      settled = true;
      stdoutStream?.end();
      stderrStream?.end();
      resolve(info);
    };
    child.once("exit", (code, signal) => settle({ code, signal }));
    child.on("error", () => {
      // A late child-side error means we'll never get a clean exit
      // event. Synthesise one so the watcher unblocks; the actual exit
      // (if it ever comes) is then a no-op via the `settled` guard.
      settle({ code: null, signal: null });
    });
  });

  // After 'spawn' fires, child.pid is non-undefined. Defensive default
  // keeps the type narrowing simple.
  const pid = child.pid ?? -1;

  return {
    pid,
    runtimeSessionId: sessionId,
    sessionDir: Promise.resolve(sessionDir),
    exit,
    kill: () => {
      try {
        child.kill();
      } catch {
        // Already dead, no-op. The exit promise will (or has) resolved.
      }
    },
  };
}
