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
   * Optional capability flags advertised to the rest of the system.
   * Absent or `undefined` means "baseline-only" (only the four required
   * verbs are guaranteed to do anything useful). Surfaced through the
   * server's `/api/runtimes` endpoint so the dashboard can disable UI
   * affordances that map to capabilities the active runtime doesn't
   * support — see {@link RuntimeCapabilities}.
   *
   * New flags are added here as runtimes diverge in functionality. Keep
   * the set small: each flag should map to a real, observable user-
   * facing affordance, not internal implementation differences.
   */
  readonly capabilities?: RuntimeCapabilities;

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
   * `opts` carries per-launch flags that the user picks at spawn time
   * (via the dashboard's "Spawn local" vs "Spawn remote" buttons). The
   * default — `{}` or `{ remote: false }` — is the original local
   * behaviour. Runtimes that don't implement a flag MUST throw a typed
   * error when asked for it (see {@link RuntimeCapabilities}); they
   * MUST NOT silently ignore an unsupported flag.
   *
   * Async by contract: a runtime may need to do a small amount of
   * idempotent fs work (write a config, open a token) before returning
   * the launch spec. Pure runtimes simply `return { ... }` without
   * `await`ing anything.
   */
  buildLaunch(
    session: Session,
    workspaceDir: string,
    opts?: BuildLaunchOpts,
  ): Promise<LaunchCommand>;

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
   * Optional. Fetch the runtime-neutral activity timeline + derived
   * "result" line for a task — end-to-end:
   *
   *   1. Locate the task's runtime-native event log (the runtime knows
   *      where its own state lives; the manager doesn't need to).
   *   2. Read the file (or however the runtime persists its log).
   *   3. Translate to the shared {@link ActivityItem} vocabulary.
   *   4. Pick the agent's "final answer" string for the headline.
   *
   * Returns `null` when the runtime has no log for this task yet
   * (task hasn't started, file not yet on disk, runtime didn't
   * persist anything). Throws on real I/O / parse errors so the
   * route layer can surface 5xx for genuine faults.
   *
   * Why one fused method instead of three (`taskEventsPath` +
   * `parseActivity` + `deriveResult`)?
   *
   *   - The three pieces are always called together by the only
   *     consumer (the activity route) — splitting them just exposed
   *     the file-system shape (path, raw bytes) up to the manager
   *     and route layers, which then leaked across runtimes (Copilot
   *     stores in a folder; a hypothetical Gemini might store in a
   *     single file or a SQLite row — the "path → bytes" model
   *     doesn't generalise).
   *   - Containing read + parse + derive inside the runtime keeps
   *     consumers unaware of `events.jsonl`, NDJSON, or any other
   *     runtime-internal artefact. They get structured ActivityItems
   *     and never know the source format.
   *
   * `opts.metadata` is the task's open-shape metadata bag (the same
   * `Task.metadata` shape `dispatchTask` populated). The runtime
   * knows which keys to consult (e.g. Copilot reads
   * `runtimeSessionId` to find its own state dir). The manager
   * deliberately does NOT pass a workdir — workdir-based discovery
   * was the abstraction leak we're closing here.
   *
   * Runtimes whose CLI doesn't emit a structured log simply omit
   * this method. The route returns `404 NoEventsYet` in that case.
   */
  taskActivity?(opts: TaskActivityOpts): Promise<TaskActivityResult | null>;
}

/** Inputs to {@link Runtime.taskActivity}. */
export interface TaskActivityOpts {
  /**
   * The task's open-shape metadata bag (`Task.metadata`). The runtime
   * looks up its own keys (typically `runtimeSessionId`) to find the
   * log on its own state directory.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Bundled result returned by {@link Runtime.taskActivity}: the
 * filtered timeline ({@link ActivityItem} entries) plus the derived
 * headline answer the dashboard renders prominently. `result` is
 * `null` when the agent never produced a final assistant message
 * (crashed early, runtime doesn't model the concept, ...).
 */
export interface TaskActivityResult {
  readonly activity: readonly ActivityItem[];
  readonly result: string | null;
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
 * Per-launch flags handed to {@link Runtime.buildLaunch}. Each field
 * maps to a user-facing affordance the dashboard exposes (typically as
 * a separate spawn button). Runtimes that don't support a flag MUST
 * throw — see the per-flag note for the right error class.
 */
export interface BuildLaunchOpts {
  /**
   * If `true`, the launch should enable remote control of the
   * interactive session (so the user can steer it from a browser /
   * mobile app). For Copilot this maps to the CLI's `--remote` flag.
   *
   * The dashboard only surfaces a "Spawn remote" button when the
   * active runtime advertises `capabilities.remoteSession === true`;
   * the runtime MUST still defend itself by throwing
   * {@link RuntimeDoesNotSupportRemoteError} when called with
   * `{ remote: true }` on a runtime that doesn't support it. Silently
   * ignoring an unsupported flag would let a HTTP caller (CLI, future
   * MCP client) bypass the UI gate and end up with a launch that
   * misses the very behaviour they asked for.
   */
  readonly remote?: boolean;
}

/**
 * Optional capability flags advertised by a {@link Runtime}. Each flag
 * is a public guarantee about a specific behaviour the runtime
 * implements; the absence of a flag means the runtime makes no claim
 * either way (and in practice doesn't support it). Surfaced by the
 * server's `/api/runtimes` endpoint so dashboards / CLIs can
 * conditionally expose UI / commands.
 */
export interface RuntimeCapabilities {
  /**
   * Whether {@link Runtime.buildLaunch} supports `opts.remote = true`.
   * When `true`, calling buildLaunch with `{ remote: true }` produces
   * a launch that puts the underlying CLI into remote-control mode.
   * When `false` or absent, the runtime throws
   * {@link RuntimeDoesNotSupportRemoteError} on that input.
   */
  readonly remoteSession?: boolean;
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
  /**
   * Mode the user chose for the most recent successful launch of this
   * session, or `null` if it has never been launched. Defaults the
   * dashboard's Resume button to the user's last intent.
   */
  readonly lastLaunchMode: "local" | "remote" | null;
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

/**
 * Runtime-neutral entries returned inside {@link TaskActivityResult}
 * by {@link Runtime.taskActivity}.
 * The vocabulary covers the three things a user actually wants to see
 * in a task's timeline:
 *
 *   - `user` — what the user asked
 *   - `assistant` — what the agent answered, plus any tool calls it
 *     issued in that turn
 *   - `summary` — terminal stats (files changed, premium requests,
 *     token usage); typically emitted at most once per task
 *
 * Lower-signal events (handshake, model-handshake, system prompts,
 * turn boundaries) are filtered out by the runtime — consumers never
 * see them via this surface. Runtimes that want to expose a "raw log"
 * surface (forensic / debug) can do so behind their own opt-in route
 * outside this contract.
 */
export type ActivityItem =
  | { readonly kind: "user"; readonly timestamp: string; readonly content: string }
  | {
      readonly kind: "assistant";
      readonly timestamp: string;
      readonly content: string;
      readonly toolRequests: readonly ToolRequest[];
    }
  | { readonly kind: "summary"; readonly timestamp: string; readonly summary: ActivitySummary };

/**
 * A tool invocation requested by the agent. Inert representation —
 * the runtime has already executed (or chosen not to) by the time the
 * dashboard renders this; we only carry it for the timeline view.
 */
export interface ToolRequest {
  readonly name: string;
  readonly arguments?: Record<string, unknown> | undefined;
}

/**
 * End-of-task aggregate stats. Field set is the union of what current
 * runtimes can produce — implementations zero out fields they don't
 * track so consumers can render unconditionally without a per-runtime
 * shape branch.
 */
export interface ActivitySummary {
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly filesModified: readonly string[];
  /** "Premium" / billable request count, when the runtime exposes one. */
  readonly premiumRequests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Last-seen model id, or `null` if the runtime doesn't surface it. */
  readonly model: string | null;
}
