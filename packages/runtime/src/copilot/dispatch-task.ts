import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir as nodeMkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentResolveResult } from "@emploke/catalog";
import { RuntimeDispatchTaskFailed, RuntimeProvisionFailed } from "../errors.js";
import type { TaskExit, TaskHandle } from "../types.js";
import { generateCopilotSessionId } from "./ids.js";
import { provisionCopilotWorkdir } from "./provision.js";

/**
 * File name for the side-channel stderr capture under the task directory.
 * Copilot's primary log surface is `events.jsonl` inside the per-session
 * state dir (which `TaskManager` junctions in as `<taskDir>/session/`);
 * this file exists only to capture errors that occur before the session
 * dir contains anything (e.g. the CLI complaining about a missing flag).
 */
export const COPILOT_STDERR_LOG = "stderr.log";

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

export interface DispatchCopilotTaskDeps {
  /**
   * Root under which Copilot maintains per-session state directories. We
   * `mkdir` `<copilotStateDir>/<sessionId>/` before spawn so the caller
   * can junction it into the task workdir without waiting for Copilot to
   * write its first event.
   */
  readonly copilotStateDir: string;
  /** Path to the `copilot` executable. Defaults to bare `"copilot"` (PATH lookup). */
  readonly copilotBin?: string;
  /** Test seam for id generation. */
  readonly randomUUID?: () => string;
  /** Test seam for spawn. */
  readonly spawn?: SpawnFn;
  /** Test seam for mkdir. */
  readonly mkdir?: typeof nodeMkdir;
}

export interface DispatchCopilotTaskOpts {
  readonly taskDir: string;
  readonly agent: AgentResolveResult;
  readonly prompt: string;
}

/**
 * Spawn `copilot -p <prompt> --resume=<uuid>` against `taskDir` and return
 * a live `TaskHandle`. The CLI runs unattended (`--allow-all`,
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
 *      a path that already exists (TaskManager can junction it
 *      immediately, no race with Copilot's first event write).
 *   3. Spawn the CLI in non-interactive mode with stderr piped to
 *      `<taskDir>/stderr.log`. Stdout is discarded — the canonical log
 *      lives in events.jsonl under the session dir.
 *   4. Wait for the `'spawn'` event to confirm the OS started the
 *      process. Spawn failures (ENOENT on `copilot`, EPERM, …) reject the
 *      dispatch promise with `RuntimeDispatchTaskFailed`. Once spawn is
 *      confirmed, post-startup failures become normal task outcomes
 *      surfaced via `handle.exit`.
 */
export async function dispatchCopilotTask(
  opts: DispatchCopilotTaskOpts,
  deps: DispatchCopilotTaskDeps,
): Promise<TaskHandle> {
  // Step 1: provision. Distinguishable from spawn failures via error type.
  try {
    await provisionCopilotWorkdir(opts.taskDir, opts.agent);
  } catch (cause) {
    throw new RuntimeProvisionFailed("copilot", opts.taskDir, cause as Error);
  }

  const mkdirImpl = deps.mkdir ?? nodeMkdir;
  const spawnImpl = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const bin = deps.copilotBin ?? "copilot";

  // Step 2: pre-allocate session id + dir.
  let sessionId: string;
  let sessionDir: string;
  try {
    sessionId = generateCopilotSessionId(deps.randomUUID);
    sessionDir = path.join(deps.copilotStateDir, sessionId);
    await mkdirImpl(sessionDir, { recursive: true });
  } catch (cause) {
    throw new RuntimeDispatchTaskFailed("copilot", opts.taskDir, cause as Error);
  }

  // Step 3: spawn.
  // `--allow-all` is required for non-interactive mode (per copilot --help)
  // and unblocks tool/path/url confirmation prompts. `--no-ask-user`
  // disables the ask_user tool so the agent can't pause waiting for input
  // we'll never deliver. `--output-format json` makes stdout a JSONL of
  // events (we don't currently consume it but it keeps stdout non-noisy
  // if a future caller needs to). `-C` is redundant with `cwd` but
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
    child = spawnImpl(bin, args, {
      cwd: opts.taskDir,
      // stdout: ignore — events.jsonl is canonical.
      // stderr: pipe — we mirror to stderr.log for bug-out only.
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
      windowsHide: true,
    });
  } catch (cause) {
    // Truly synchronous spawn failure. Rare on Node; usually async via 'error'.
    throw new RuntimeDispatchTaskFailed("copilot", opts.taskDir, cause as Error);
  }

  // Step 4: await `'spawn'` so a failed exec (ENOENT, EPERM) surfaces
  // synchronously to the caller instead of via a never-resolving exit
  // promise. Without this guard a missing `copilot` binary would silently
  // park the task in `running` forever.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    child.once("spawn", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    child.once("error", (err) => {
      if (!settled) {
        settled = true;
        reject(new RuntimeDispatchTaskFailed("copilot", opts.taskDir, err));
      }
    });
  });

  // Pipe stderr to disk. Append-mode so a re-dispatch (future feature)
  // wouldn't truncate prior context, but in MVP each task dir is fresh.
  const stderrPath = path.join(opts.taskDir, COPILOT_STDERR_LOG);
  let stderrStream: WriteStream | null = null;
  if (child.stderr !== null) {
    stderrStream = createWriteStream(stderrPath, { flags: "a" });
    child.stderr.pipe(stderrStream);
  }

  // Build the exit promise. Closes the stderr stream on exit so the file
  // descriptor doesn't linger.
  const exit = new Promise<TaskExit>((resolve) => {
    child.once("exit", (code, signal) => {
      stderrStream?.end();
      resolve({ code, signal });
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
