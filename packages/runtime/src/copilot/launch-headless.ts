import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import path from "node:path";
import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";
import crossSpawn from "cross-spawn";
import { RuntimeHeadlessLaunchFailed, RuntimeProvisionFailed } from "../errors.js";
import type { PlaceholderContext } from "../placeholders.js";
import type { RuntimeExit, RuntimeHandle } from "../types.js";
import { isCopilotSessionId } from "./ids.js";
import { COPILOT_MCP_CONFIG, provisionCopilotWorkdir } from "./provision.js";

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
 * Re-exported workspace `.mcp.json` filename. The single source of truth
 * lives in `provision.ts` (the actual writer); the launcher's existence
 * probe and `--additional-mcp-config` argv consume it from here. Kept as
 * a re-export so `@emploke/runtime` consumers see a stable symbol on the
 * launch-headless surface.
 */
export { COPILOT_MCP_CONFIG };

/**
 * Argv fragment appended to non-interactive `copilot -p` when the spawn
 * cwd contains a workspace `.mcp.json`. Two separate argv entries (NOT a
 * single combined string) — matches how the Copilot CLI parses long
 * options with values and keeps the call shape symmetric with every
 * other flag in {@link buildCopilotHeadlessArgs}.
 *
 * The leading `@` tells Copilot CLI "load from this file path"; the path
 * is relative because the child process's cwd is `taskDir`, which is
 * exactly where `provisionCopilotWorkdir` wrote the file. This avoids
 * any host-path resolution gymnastics.
 *
 * Why this exists at all: the upstream Copilot CLI silently SKIPS
 * workspace-level `.mcp.json` MCP servers in non-interactive (`-p`)
 * mode — they're filtered out before any start attempt and never appear
 * in the agent's tool surface, with no warning. Passing
 * `--additional-mcp-config` re-routes the same file through the loader
 * that `-p` honours, so workspace MCPs become available to task agents.
 *
 * Tracked: emploke #105 / upstream github/copilot-cli#3313.
 */
const ADDITIONAL_MCP_CONFIG_FLAG = "--additional-mcp-config";
const ADDITIONAL_MCP_CONFIG_VALUE = `@./${COPILOT_MCP_CONFIG}`;

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
 * Best-effort extract `data.sessionId` from a single JSONL line.
 * Returns the id when the line parses as JSON, has `type === "session.start"`,
 * and carries a valid Copilot session id in `data.sessionId`. Returns
 * `null` for any other shape (malformed JSON, unrelated event type,
 * missing field, invalid id). Exported for unit-test introspection.
 *
 * Robustness: Copilot's `--output-format json` emits one event per
 * line, but if the upstream changes the wrap or interleaves anything
 * else (warnings, banners) the parser silently skips those lines and
 * keeps reading until a real `session.start` arrives or the launch
 * timeout fires.
 */
export function tryExtractSessionId(line: string): string | null {
  let evt: unknown;
  try {
    evt = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof evt !== "object" || evt === null) return null;
  const obj = evt as { type?: unknown; data?: unknown };
  if (obj.type !== "session.start") return null;
  if (typeof obj.data !== "object" || obj.data === null) return null;
  const data = obj.data as { sessionId?: unknown };
  if (!isCopilotSessionId(data.sessionId)) return null;
  return data.sessionId;
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
   * Root under which Copilot maintains per-session state directories.
   * The Copilot CLI mints its own session id at spawn time and writes
   * events under `<copilotStateDir>/<sessionId>/`. The runtime
   * discovers that id by parsing the first `session.start` event off
   * stdout, then resolves the handle's `sessionDir` promise to
   * `<copilotStateDir>/<sessionId>/`.
   *
   * No pre-creation: we used to `mkdir <copilotStateDir>/<id>/` before
   * spawn and pass `--resume=<id>` so Copilot would "create-if-missing
   * at this id." That contract broke upstream — `--resume=<new-uuid>`
   * now fails with `No session, task, or name matched ...` instead of
   * creating. The discovery-from-stdout path is upstream-stable
   * (`type: "session.start"` with `data.sessionId` is part of Copilot's
   * documented event log shape).
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
  /** Test seam for spawn. */
  readonly spawn?: SpawnFn;
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
  /**
   * Maximum time to wait for the first `session.start` event on the
   * child's stdout (which carries the Copilot-minted session id we
   * need to resolve `sessionDir`). Defaults to 30000 ms.
   *
   * In practice Copilot emits this event within ~100ms of spawn. The
   * cap matches `spawnTimeoutMs` to bound worst-case AV/EDR scan
   * delays + slow disk. If exceeded, the launch fails with
   * `RuntimeHeadlessLaunchFailed("session.start not observed within ...")`
   * and the child is killed to avoid leaking a zombie. This is
   * functionally "Copilot started but produced no usable output"
   * which is the same failure mode as a hung child.
   *
   * Tests inject a small value (e.g. 50 ms) to keep them snappy.
   */
  readonly sessionStartTimeoutMs?: number;
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
 * Inputs to {@link buildCopilotHeadlessArgs}.
 *
 * `mcpConfigExists` is computed by the caller (one `existsSync` against
 * `<taskDir>/.mcp.json`) so the helper itself stays pure and trivially
 * unit-testable.
 *
 * Notably absent: any session id. Copilot mints its own session id at
 * spawn time and reports it back via the first `session.start` event
 * on stdout — we no longer pre-allocate via `--resume=<our-uuid>`
 * because that upstream contract broke (`--resume=<new-uuid>` now
 * errors `No session, task, or name matched ...` instead of
 * create-if-missing).
 */
export interface BuildCopilotHeadlessArgsOpts {
  readonly prompt: string;
  readonly taskDir: string;
  /**
   * Whether `<taskDir>/.mcp.json` is present at the moment of spawn. When
   * true, the helper appends `--additional-mcp-config @./.mcp.json` so
   * workspace MCP servers actually load under `copilot -p` (see
   * {@link ADDITIONAL_MCP_CONFIG_FLAG} for the upstream-bug context).
   */
  readonly mcpConfigExists: boolean;
}

/**
 * Build the argv passed to `cross-spawn` for a non-interactive
 * (`copilot -p`) launch. Pure function — same inputs always produce the
 * same array — so it can be exercised by unit tests without spawning a
 * real child process or mocking `node:fs`.
 *
 * Flag rationale (kept here so the launcher body doesn't have to inline
 * a wall of comments around an array literal):
 *
 *   - `--allow-all`: required for non-interactive mode (per
 *     `copilot --help`). Unblocks tool / path / URL confirmation prompts.
 *   - `--no-ask-user`: disables the `ask_user` tool so the agent can't
 *     pause waiting for input we'll never deliver.
 *   - `--output-format json`: makes stdout a JSONL of events. We don't
 *     currently consume that stream — the canonical event log lives at
 *     `<sessionDir>/events.jsonl` and the dashboard reads it through
 *     the runtime's `readActivity` surface — but the flag stays on so
 *     a future progress-streaming UI can attach to stdout without
 *     changing the spawn arguments.
 *   - `-C <taskDir>`: redundant with `cwd` but belt-and-suspenders for
 *     tools that introspect argv.
 *   - `--additional-mcp-config @./.mcp.json` (conditional): workaround
 *     for the upstream `-p` mode silently dropping workspace
 *     `.mcp.json` servers. Appended only when the file actually exists
 *     in `taskDir` so we don't pass a flag with nothing to load. See
 *     emploke #105 / upstream github/copilot-cli#3313.
 */
export function buildCopilotHeadlessArgs(opts: BuildCopilotHeadlessArgsOpts): string[] {
  const args: string[] = [
    "-p",
    opts.prompt,
    "--allow-all",
    "--no-ask-user",
    "--output-format",
    "json",
    "-C",
    opts.taskDir,
  ];
  if (opts.mcpConfigExists) {
    args.push(ADDITIONAL_MCP_CONFIG_FLAG, ADDITIONAL_MCP_CONFIG_VALUE);
  }
  return args;
}

/**
 * Spawn `copilot -p <prompt>` against `taskDir` and return a live
 * {@link RuntimeHandle}. The CLI runs unattended (`--allow-all`,
 * `--no-ask-user`) and emits structured events into its per-session state
 * directory, which the caller can mount under the task workdir.
 *
 * Sequence:
 *   1. Provision the workdir (AGENTS.md, .mcp.json, .github/skills, …) the
 *      same way `provision()` does for an interactive session. Wraps the
 *      failure as `RuntimeProvisionFailed` so callers can distinguish
 *      provisioning trouble from spawn trouble.
 *   2. Spawn the CLI in non-interactive mode with stdout/stderr piped to
 *      `<taskDir>/stdout.log` and `<taskDir>/stderr.log` respectively.
 *      The canonical log lives in events.jsonl under the session dir;
 *      these files mostly catch CLI-level diagnostics and exist
 *      primarily to give the child a real file handle for stdout, which
 *      Windows requires for `process.stdout` flushing to succeed.
 *   3. Wait for the `'spawn'` event to confirm the OS started the
 *      process. Spawn failures (ENOENT on `copilot`, EPERM, …) reject the
 *      launchHeadless promise with `RuntimeHeadlessLaunchFailed`. Once spawn is
 *      confirmed, post-startup failures become normal task outcomes
 *      surfaced via `handle.exit`.
 *   4. Watch stdout for the first `session.start` event and extract
 *      `data.sessionId`. That id is what Copilot used for its native
 *      per-session state dir under `<copilotStateDir>/<sessionId>/`, so
 *      we resolve the handle's `sessionDir` to that path. The launch
 *      promise blocks on this discovery so callers receive a handle
 *      with `runtimeSessionId` already set — required for
 *      `Runtime.readActivity(runtimeSessionId)` to work.
 *
 * **Why session id is discovered post-spawn, not pre-allocated.** We
 * used to pre-mint a UUID, `mkdir <copilotStateDir>/<uuid>/`, and pass
 * `--resume=<uuid>` so Copilot would "create the session at this id."
 * That upstream contract broke — `--resume=<new-uuid>` now errors with
 * `No session, task, or name matched ...` instead of create-if-missing,
 * which made every fresh task dispatch fail at exit code 1 with no
 * events.jsonl ever written. Discovery from the first `session.start`
 * event uses a contract that's part of Copilot's stable event log
 * shape and works regardless of whether the CLI accepts pre-allocated
 * ids.
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

  // Bin path. Default `"copilot"`; cross-spawn at the spawn site
  // handles PATH lookup, PATHEXT iteration (Windows), and the
  // `.cmd` / `.bat` cmd.exe wrap (CVE-2024-27980 mitigation).
  // Production users should `npm install -g @github/copilot`; the
  // WinGet-installed Copilot has a separate stdout-corruption bug
  // under non-console spawn that emploke does not work around.
  const bin = deps.copilotBin ?? "copilot";

  // Step 2: spawn.
  // Build argv via the pure helper so the construction is exercised by
  // unit tests without spawning a real child. The conditional
  // `--additional-mcp-config` flag (see helper JSDoc) is gated on a
  // single sync `existsSync` against `<taskDir>/.mcp.json`. The probe
  // runs AFTER `provisionCopilotWorkdir` (Step 1) so we observe the
  // file the provisioner just wrote when the agent declares MCPs;
  // when the agent has no MCPs no file exists and the flag is
  // omitted, matching upstream's "nothing to load" expectation.
  const mcpConfigPath = path.join(opts.taskDir, COPILOT_MCP_CONFIG);
  const mcpConfigExists = existsSync(mcpConfigPath);
  const args = buildCopilotHeadlessArgs({
    prompt: opts.prompt,
    taskDir: opts.taskDir,
    mcpConfigExists,
  });

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

  // Step 4: discover Copilot's session id by parsing the first
  // `session.start` event off stdout. We attach a SECOND `data`
  // listener (the first being the pipe to stdout.log) — Node Readable
  // streams broadcast `data` events to every listener attached during
  // flowing mode, so the pipe and the parser both see every chunk
  // without consumption conflict.
  //
  // We block the launch promise on this discovery so callers receive
  // a handle with `runtimeSessionId` already populated. Without it
  // `Runtime.readActivity(runtimeSessionId)` has nothing to read —
  // there's no equivalent "wait for session id" surface on the
  // RuntimeHandle, and adding one would push the wait into every
  // consumer.
  //
  // Timeout: in practice Copilot emits session.start within ~100ms of
  // spawn. The 30s cap matches `spawnTimeoutMs` and bounds worst-case
  // AV/EDR scan delays + slow disk. If exceeded, we kill the child
  // and reject — same shape as a spawn failure.
  const sessionStartTimeoutMs = deps.sessionStartTimeoutMs ?? 30_000;
  const sessionId = await new Promise<string>((resolve, reject) => {
    if (child.stdout === null) {
      reject(
        new RuntimeHeadlessLaunchFailed(
          "copilot",
          opts.taskDir,
          new Error("child has no stdout; cannot discover session id"),
        ),
      );
      return;
    }
    let buffer = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeListener("data", onData);
      child.removeListener("exit", onExit);
      fn();
    };
    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) {
          const id = tryExtractSessionId(line);
          if (id !== null) {
            settle(() => resolve(id));
            return;
          }
        }
        nl = buffer.indexOf("\n");
      }
    };
    const onExit = () => {
      settle(() =>
        reject(
          new RuntimeHeadlessLaunchFailed(
            "copilot",
            opts.taskDir,
            new Error("copilot exited before emitting session.start event"),
          ),
        ),
      );
    };
    const timer = setTimeout(() => {
      // Kill the child so we don't leak a process behind the rejected
      // promise. The exit watcher above will then settle with
      // {code:null, signal:null} via the synthetic exit path.
      try {
        child.kill();
      } catch {
        // Already gone; the synthetic exit path covers it.
      }
      settle(() =>
        reject(
          new RuntimeHeadlessLaunchFailed(
            "copilot",
            opts.taskDir,
            new Error(
              `timed out after ${sessionStartTimeoutMs}ms waiting for first session.start event from copilot stdout`,
            ),
          ),
        ),
      );
    }, sessionStartTimeoutMs);
    timer.unref();
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });

  const sessionDir = path.join(deps.copilotStateDir, sessionId);

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
