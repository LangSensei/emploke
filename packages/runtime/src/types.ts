import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";

/**
 * A Runtime adapts a third-party CLI (Copilot, Gemini, Claude Code, …) for use
 * by emploke. It owns four operations against the CLI's on-disk world:
 *
 *  - `provision`: bake an agent into a workdir so the CLI can be launched there
 *  - `refresh`: read the CLI's view of activity for an emploke session
 *  - `buildLaunch`: build the shell command that drops the user into the CLI
 *  - `deleteState`: remove the CLI's record of an emploke session
 *
 * Runtimes are stateless across calls — all per-session data lives either in
 * `Session.runtimeSessionId` (an opaque, runtime-specific id) or in the CLI's
 * own storage. Runtimes never mutate the `Session` they receive; instead they
 * return updated values that the caller persists.
 *
 * The interface is deliberately small. Anything CLI-specific that doesn't fit
 * one of these four verbs (e.g. logging, telemetry) is the runtime's private
 * concern and should not leak into emploke's surface.
 */
export interface Runtime {
  /**
   * Stable identifier for this runtime, written into `Session.runtime` and
   * used by `RuntimeRegistry` as the lookup key. Conventionally the CLI's
   * canonical name in lowercase: `"copilot"`, `"gemini"`, `"claude-code"`.
   */
  readonly kind: string;

  /**
   * Bake `agent` into `workdir` so the CLI can be launched against it.
   *
   * The returned `runtimeSessionId` becomes the binding between this emploke
   * session and the CLI's notion of a session:
   *
   *  - **Pre-allocating runtimes** (e.g. Copilot, which accepts
   *    `--resume=<arbitrary-uuid>` and creates the session if missing) return
   *    a freshly-minted id here. Subsequent `buildLaunch` calls always pass
   *    `--resume=<that-id>`, so first launch creates and later launches resume.
   *  - **Discovery-only runtimes** (e.g. Gemini, where the id is minted by
   *    the CLI at first launch and must be scraped from logs / fs / stdout
   *    afterwards) return `null`. The id will be filled in later by `refresh`.
   *
   * `workdir` is guaranteed to exist and be empty. Provision is *not* required
   * to be idempotent; the caller arranges atomicity (rolling back the workdir
   * on failure).
   *
   * `catalog` is the source of agent / skill / mcp file content — the runtime
   * pulls them via streams (`catalog.agentEntries`, `catalog.skillEntries`,
   * `catalog.getMcpContent`) instead of resolving on-disk catalog paths. This
   * keeps the runtime backend-agnostic so a future SQLite-backed catalog
   * works without code changes here.
   *
   * `ctx.workspaceDir` is the absolute path of the workspace this session
   * lives under (the parent of `<workspaceDir>/sessions/<id>/...`). Runtimes
   * use it to resolve `${workspaceDir}` placeholders in MCP / agent specs so
   * marketplace-shareable configs can refer to per-workspace state without
   * encoding machine paths. See {@link substitutePlaceholders} for the
   * vocabulary.
   */
  provision(
    workdir: string,
    agent: AgentResolveResult,
    catalog: CatalogManager,
    ctx: ProvisionContext,
  ): Promise<{
    runtimeSessionId: string | null;
  }>;

  /**
   * Inspect the CLI's view of `session` and return fresh activity metadata.
   *
   * Returns `null` when the CLI has no record of this session — either the
   * user hasn't launched yet, or the CLI's state was deleted out of band. A
   * non-null return guarantees `runtimeSessionId` is known, so this is also
   * the discovery point for runtimes that mint ids at first launch.
   *
   * Implementations should be idempotent and side-effect-free against the
   * CLI's own storage. They may perform fs / network reads but must not
   * write back to the CLI's state directories.
   */
  refresh(session: Session): Promise<{
    lastActiveAt: string;
    preview: string | null;
    runtimeSessionId: string;
  } | null>;

  /**
   * Build the shell incantation that drops the user into an interactive
   * session against the CLI. Inspects `session.runtimeSessionId` to decide
   * whether to include a resume flag.
   *
   * The caller is expected to have just invoked `refresh()` so that
   * `runtimeSessionId` is as up to date as it can be.
   *
   * `workspaceDir` is the absolute path of the workspace this session
   * lives under (the parent of `<workspace>/sessions/<id>/workdir`).
   * Runtimes are free to ignore it; CLIs whose interactive mode requires
   * a per-launch precondition keyed off the workspace root (e.g. Copilot
   * needs an entry in `~/.copilot/config.json` `trustedFolders` to
   * suppress its folder-trust prompt) use it to perform that
   * precondition here, lazily, only when the user actually launches.
   *
   * Async by contract: a runtime may need to do a small amount of
   * idempotent fs work (write a config, open a token) before returning
   * the launch spec. Pure runtimes simply `return { ... }` without
   * `await`ing anything.
   */
  buildLaunch(session: Session, workspaceDir: string): Promise<LaunchCommand>;

  /**
   * Remove the CLI's recorded state for `session`. No-op if no state exists.
   * Throws on partial failure (e.g. permission denied removing some files);
   * the caller is responsible for surfacing this to the user.
   */
  deleteState(session: Session): Promise<void>;

  /**
   * Optional. Runtimes whose underlying CLI supports non-interactive
   * scripting (e.g. Copilot's `-p/--prompt`) implement this to spawn the
   * CLI as a detached worker that consumes `prompt` and exits when done.
   *
   * The runtime owns the subprocess for the life of the call: it picks
   * CLI flags appropriate for unattended execution (allow-all-tools,
   * disable user prompts, structured output where available), wires up
   * its own stderr capture, and returns a `TaskHandle` so the caller can
   * observe completion without holding the spawn machinery itself.
   *
   * Runtimes that lack a non-interactive mode simply omit this method;
   * `TaskManager` checks for its presence and raises a clear error at
   * dispatch time when the chosen runtime cannot run tasks.
   */
  dispatchTask?(opts: DispatchTaskOpts): Promise<TaskHandle>;

  /**
   * Optional. Locate the runtime-native event log for a task.
   *
   * Returns the absolute path to the log file the dashboard (or any
   * other consumer) should stream when the user opens a task's "Events"
   * view. Returns `null` when the runtime has no concept of a task event
   * log, or when the log is not yet available (not provisioned, file
   * not yet created, ...).
   *
   * The contract is intentionally narrow: the runtime says *where* the
   * log lives, not *what's in it*. Each runtime's log format is its own
   * concern (Copilot writes NDJSON; future runtimes may use plain text,
   * a different JSON shape, or a directory). Consumers either treat the
   * file as opaque bytes (current dashboard behaviour) or branch on
   * `Task.metadata.runtime` to choose a parser. A typed cross-runtime
   * `TaskEvent` schema is intentionally out of scope for this iteration.
   *
   * `taskWorkdir` is the manager-side workdir for this task (the same
   * value `dispatchTask` was handed as `taskDir`). The runtime is free
   * to either resolve a path beneath the workdir (e.g. via a junction
   * the manager installed) or compute a path elsewhere on its own
   * private state directory.
   *
   * Runtimes with no event log (or that haven't decided on one yet)
   * simply omit this method; the server treats absent + `null` returns
   * the same way (404 NoEventsYet on the events route).
   */
  taskEventsPath?(taskWorkdir: string): string | null;
}

/**
 * Inputs to `Runtime.dispatchTask`. `taskDir` is guaranteed to exist and
 * doubles as the subprocess `cwd`; the caller is responsible for laying
 * down whatever the agent needs there before invoking dispatch (typically
 * by calling `Runtime.provision` on the same dir first).
 *
 * `catalog` carries the byte-source for skill / agent / mcp content, see
 * the docstring on {@link Runtime.provision} for rationale.
 *
 * `workspaceDir` lets the runtime resolve `${workspaceDir}` placeholders
 * in MCP / agent specs the same way `provision` does (see
 * {@link Runtime.provision} for the vocabulary).
 */
export interface DispatchTaskOpts {
  readonly taskDir: string;
  readonly agent: AgentResolveResult;
  readonly catalog: CatalogManager;
  readonly prompt: string;
  readonly workspaceDir: string;
}

/**
 * Cross-runtime context handed to {@link Runtime.provision}. Keeps the
 * positional arg list short while leaving room for future per-call
 * fields (e.g. a per-session env override) without churning every
 * runtime adapter.
 */
export interface ProvisionContext {
  /** Absolute path of the workspace this session/task belongs to. */
  readonly workspaceDir: string;
}

/**
 * Live handle to a dispatched task. Returned synchronously (via Promise)
 * from `Runtime.dispatchTask` once the subprocess is up; the caller awaits
 * `exit` for terminal status and may consult `sessionDir` to mount the
 * runtime's native log directory under the task's workdir.
 *
 * **Why `sessionDir` is a Promise** rather than a sync `string | null`
 * (which is the shape the interactive session surface uses on
 * `Runtime.provision`): tasks are spawned by the runtime *now*, so the
 * runtime owns a real subprocess and can naturally produce a future value
 * for any id/path it learns post-spawn. Interactive sessions are launched
 * by a human at some unknown later time, so the runtime can't promise
 * anything; the manager discovers the id later via `refresh()`. Same
 * underlying goal in both APIs — "don't assume the CLI knows its session
 * id at any specific moment" — expressed with the mechanism that fits each
 * ownership pattern.
 */
export interface TaskHandle {
  /** OS process id of the spawned CLI. */
  readonly pid: number;

  /**
   * Id the runtime minted for the underlying CLI session/state. Optional
   * because only pre-allocating runtimes (Copilot) know it up front;
   * discovery-only runtimes leave it undefined and the caller learns it
   * (if at all) by other means.
   *
   * Persisted by `TaskManager` into `task.json` for later inspection (and
   * for callers who want to drive the underlying CLI directly, e.g.
   * `copilot --resume=<id>`).
   */
  readonly runtimeSessionId?: string;

  /**
   * Where the runtime is writing its native per-session log directory for
   * this task. `TaskManager` junctions this into `<taskDir>/session/` so
   * the dashboard can serve `events.jsonl` (or whatever the runtime calls
   * its log) without coupling to per-runtime layout. See the type-level
   * comment above for the Promise rationale.
   */
  readonly sessionDir: Promise<string>;

  /**
   * Resolves when the subprocess exits. `code` is `null` if the process
   * was terminated by a signal (in which case `signal` carries it); `signal`
   * is `null` for a normal exit.
   */
  readonly exit: Promise<TaskExit>;

  /**
   * Best-effort terminate. Sends SIGTERM (or the platform equivalent); the
   * caller awaits `exit` to confirm termination. Used by
   * `TaskManager.shutdown` during server shutdown; not exposed to end users
   * in MVP.
   */
  kill(): void;
}

export interface TaskExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * A session as seen by the runtime layer. This is the same shape the
 * `@emploke/session` package exposes; we re-declare it here so that
 * `@emploke/runtime` does not depend on `@emploke/session` (the dependency
 * arrow runs the other way).
 */
export interface Session {
  readonly id: string;
  readonly workdir: string;
  readonly agent: string;
  readonly runtime: string;
  readonly runtimeSessionId: string | null;
  readonly createdAt: string;
  readonly lastActiveAt: string | null;
  readonly preview: string | null;
}

/**
 * A shell-runnable launch command, returned by `Runtime.buildLaunch`. The
 * `cmd`/`args`/`cwd` triple is suitable for `child_process.spawn`; `display`
 * is a single-line string suitable for displaying to the user or copying to
 * the clipboard as a fallback when programmatic spawn fails.
 */
export interface LaunchCommand {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly display: string;
}
