import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";

/**
 * A Runtime adapts a third-party CLI (Copilot, Gemini, Claude Code, …) for use
 * by emploke. It owns operations against the CLI's on-disk world:
 *
 *  - `provision`: bake an agent into a workdir so the CLI can be launched there
 *  - `refresh`: read the CLI's view of activity for an emploke session
 *  - `buildLaunch`: build the shell command that drops the user into the CLI
 *  - `deleteState`: remove the CLI's record of an emploke session
 *  - `dispatchTask?` / `taskActivity?` / `deleteTaskState?`: the parallel trio
 *    for autonomous tasks (optional — runtimes that lack a non-interactive
 *    mode simply omit them)
 *
 * Runtimes are stateless across calls — all per-session data lives either in
 * `Session.runtimeSessionId` (an opaque, runtime-specific id) or in the CLI's
 * own storage. Runtimes never mutate the `Session` they receive; instead they
 * return updated values that the caller persists.
 *
 * The interface is deliberately small. Anything CLI-specific that doesn't fit
 * these verbs (e.g. logging, telemetry) is the runtime's private concern and
 * should not leak into emploke's surface.
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
   * Optional. Remove the runtime's recorded state for a previously-dispatched
   * task. Mirrors {@link deleteState} for sessions; called by `TaskManager`
   * when a task is purged so the runtime's per-task event log (Copilot's
   * `<copilotStateDir>/<runtimeSessionId>/`, etc.) doesn't leak after the
   * task row + workdir are gone.
   *
   * `opts.metadata` is the task's open-shape metadata bag (the same
   * `Task.metadata` shape `dispatchTask` populated, identical to
   * {@link TaskActivityOpts}). The runtime knows which keys to consult
   * (typically `runtimeSessionId`) and silently no-ops when the relevant
   * key is missing or unparseable, the same way {@link deleteState} does
   * for sessions.
   *
   * Throws on partial failure (e.g. permission denied removing some files);
   * the caller (`TaskManager.delete({ purge: true })`) propagates as
   * `RuntimeStateDeletionFailed` so the user sees a clear failure rather
   * than a silently-leaked state dir. The order on the manager side is
   * "runtime first, then local row + workdir" — a runtime failure aborts
   * before any local removal, mirroring `SessionManager.delete`.
   *
   * Runtimes whose CLI does not persist per-task state simply omit this
   * method; the manager treats absence as "nothing to clean up".
   */
  deleteTaskState?(opts: TaskStateOpts): Promise<void>;

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
   * was the abstraction leak this method closes.
   *
   * Runtimes whose CLI doesn't emit a structured log simply omit
   * this method. The route returns `404 NoEventsYet` in that case.
   */
  taskActivity?(opts: TaskActivityOpts): Promise<TaskActivityResult | null>;

  /**
   * Optional. Live-tail variant of {@link taskActivity}. Returns an
   * AsyncIterable that yields {@link ActivityItem}s as they're
   * written to the runtime's native log, until the iterator is
   * closed (caller aborts, file is closed by the CLI, or the task
   * reaches a terminal state — runtimes are responsible for the
   * second case via fs watch / poll).
   *
   * Used by the SSE `/activity/stream` endpoint to push live events
   * to the dashboard while a task is still running. Static views
   * (post-mortem) MUST NOT use this hook — use the bounded
   * {@link taskActivity} for those.
   *
   * Cleanup contract: when `opts.signal` aborts (HTTP client
   * disconnect, server shutdown), the iterator MUST stop within
   * a few hundred ms and release any file handles / watchers.
   *
   * Runtimes that don't expose a streaming source simply omit this
   * method; the SSE route then falls back to polling
   * {@link taskActivity} every few seconds.
   */
  taskActivityStream?(opts: TaskActivityStreamOpts): AsyncIterable<ActivityItem>;
}

/** Inputs to {@link Runtime.taskActivity}. */
export interface TaskActivityOpts {
  /**
   * The task's open-shape metadata bag (`Task.metadata`). The runtime
   * looks up its own keys (typically `runtimeSessionId`) to find the
   * log on its own state directory.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
  /**
   * Return only items with `seq > cursor`. When omitted, the runtime
   * returns the most recent `limit` items (the post-mortem default).
   * Used by paginated reads (`?cursor=N`) and SSE reconnection
   * (`Last-Event-ID: N` header).
   */
  readonly cursor?: number;
  /**
   * Maximum number of items to return. Server enforces a default
   * (50) and a hard maximum (500) before calling into the runtime.
   * Runtimes MUST honour this even when reading from a small log,
   * so callers can rely on the bound for memory budgeting.
   */
  readonly limit?: number;
}

/**
 * Inputs to {@link Runtime.deleteTaskState}. Same shape as
 * {@link TaskActivityOpts} — both are "given a task's metadata, do
 * something runtime-specific with the per-task state dir". Kept as a
 * separate type so future divergence (e.g. a `force` flag for one but
 * not the other) doesn't churn both call sites.
 */
export interface TaskStateOpts {
  /**
   * The task's open-shape metadata bag (`Task.metadata`). The runtime
   * looks up its own keys (typically `runtimeSessionId`) to locate its
   * own per-task state dir.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Bundled result returned by {@link Runtime.taskActivity}: the
 * filtered timeline ({@link ActivityItem} entries) plus the derived
 * headline answer the dashboard renders prominently. `result` is
 * `null` when the agent never produced a final assistant message
 * (crashed early, runtime doesn't model the concept, ...).
 *
 * Pagination + truncation:
 *
 * - `cursor` is the seq number to pass back as `opts.cursor` for the
 *   next page; `null` when this page is the tail.
 * - `truncated` is non-null when the runtime had to drop bytes /
 *   items to stay within the safety cap (e.g. `events.jsonl` too
 *   large to read in full). Consumers MUST surface this so the
 *   user / LLM knows they're seeing a partial timeline.
 */
export interface TaskActivityResult {
  readonly activity: readonly ActivityItem[];
  readonly result: string | null;
  /** seq to pass as next `opts.cursor`; null when caller has the tail. */
  readonly cursor: number | null;
  /** Total items in the underlying log, when known. Useful for "showing X of Y" UI. */
  readonly totalItems?: number;
  /**
   * Set when the runtime had to truncate the source (file too large,
   * cap hit). Always non-null when truncation occurred so consumers
   * never render a partial timeline as if it were complete.
   */
  readonly truncated?: TruncationInfo;
}

/**
 * Why and how a {@link TaskActivityResult} was truncated. Always
 * present when truncation happened; absent when the response is the
 * complete timeline.
 */
export interface TruncationInfo {
  /**
   * `"size_limit"` — runtime hit a raw byte cap reading the log.
   * `"page_limit"` — caller's `limit` was smaller than available items.
   */
  readonly reason: "size_limit" | "page_limit";
  /** Bytes dropped from the start of the source file (size_limit only). */
  readonly droppedBytes?: number;
  /** Items dropped from the start (size_limit only — when raw read was trimmed). */
  readonly droppedItems?: number;
  /** Hint string for the LLM when this response is consumed via MCP. */
  readonly hint?: string;
}

/** Inputs to {@link Runtime.taskActivityStream}. */
export interface TaskActivityStreamOpts {
  /** Same shape as {@link TaskActivityOpts.metadata}. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /**
   * Resume from this seq number (exclusive). Used by SSE
   * reconnection (`Last-Event-ID` header). When omitted, the
   * stream starts from the next event written to the log — it does
   * NOT replay history (use {@link Runtime.taskActivity} for that).
   */
  readonly cursor?: number;
  /**
   * Caller's abort signal. The runtime MUST stop tailing and clean
   * up file handles / watchers when this fires. Used by the SSE
   * route to release resources when the HTTP client disconnects.
   */
  readonly signal?: AbortSignal;
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
   * Persisted by `TaskManager` into the task's `metadata.runtimeSessionId`
   * column for later inspection (and for callers who want to drive the
   * underlying CLI directly, e.g. `copilot --resume=<id>`). Also the key
   * the runtime reads back from `Task.metadata` in `taskActivity` and
   * `deleteTaskState`.
   */
  readonly runtimeSessionId?: string;

  /**
   * Where the runtime is writing its native per-session log directory for
   * this task. The runtime owns reads against this directory end-to-end via
   * `taskActivity` (and removal via `deleteTaskState`) — `TaskManager` does
   * NOT mirror it back into the task workdir, so consumers (dashboard, CLI)
   * never need to know per-runtime layout. The Promise lets discovery-only
   * runtimes resolve the path post-spawn; see the type-level comment above
   * for the rationale.
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
 * by {@link Runtime.taskActivity}, and yielded by
 * {@link Runtime.taskActivityStream}.
 *
 * Discriminated union covering the cross-runtime semantic primitives
 * observed in Copilot, Gemini, OpenAI Codex, and Claude Code:
 *
 *   - `user` — what the user asked, plus optional attachments
 *   - `assistant` — what the agent answered (plain text only — tool
 *     calls live in their own items); optional model + tokens
 *   - `thinking` — agent reasoning trace (Gemini `thoughts`, Claude
 *     `thinking` blocks, Codex `agent_reasoning` events). Runtimes
 *     that don't expose reasoning simply emit zero of these.
 *   - `tool_call` — a single tool invocation. Runtimes that expose
 *     begin/end pairs (Copilot, Codex) merge them into one item with
 *     `status` flipping `running` → `success`/`error`. Runtimes that
 *     inline tool calls on assistant turns (Gemini, Claude) emit one
 *     item per call alongside the assistant text.
 *   - `system` — out-of-band events (Copilot hooks/skills/subagents,
 *     Codex context_compacted, runtime warnings). `subKind` carries
 *     the runtime-specific tag for filtering.
 *   - `summary` — terminal stats (Copilot `session.shutdown`, Codex
 *     `task_complete`); typically emitted at most once per task.
 *
 * Every item carries a monotonic `seq` (per task) — this is the
 * canonical cursor for pagination and SSE reconnection. `id` is the
 * runtime-native UUID when available; `parentSeq` is optional
 * threading metadata where the runtime exposes it (Copilot
 * `parentId`, Claude Code `parentUuid`).
 *
 * Future runtimes add new kinds via PR; consumers that don't
 * recognise a kind should treat it as opaque (renderable as JSON)
 * rather than crashing.
 */
export type ActivityItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolCallItem
  | SystemItem
  | SummaryItem;

interface BaseActivityItem {
  /**
   * Monotonic per-task sequence number. Starts at 0 for the first
   * item, increments by 1 per item. Used by the streaming endpoint
   * (`Last-Event-ID`), by paginated `taskActivity({ cursor })`, and
   * by the dashboard to dedup items arriving via SSE after a
   * one-shot fetch.
   */
  readonly seq: number;
  /**
   * Runtime-native stable id for this item, when the runtime exposes
   * one (Copilot event id, Claude Code uuid, Gemini id). Optional —
   * runtimes that only have positional ordering (Codex, SWE-agent)
   * omit it. Consumers should NOT key persistent state off this; use
   * `seq` for that.
   */
  readonly id?: string;
  /**
   * Sequence number of the item this one logically follows, when the
   * runtime exposes parent-child threading (Copilot, Claude Code).
   * Optional — most runtimes don't model threading explicitly.
   */
  readonly parentSeq?: number;
  /** ISO 8601 UTC timestamp the runtime recorded for this event. */
  readonly timestamp: string;
}

/** A user turn (prompt + optional attachments). */
export interface UserItem extends BaseActivityItem {
  readonly kind: "user";
  readonly text: string;
  /**
   * Multi-modal payload the user attached to this turn (images,
   * file references). Runtimes that don't accept attachments simply
   * omit this field. Today only Codex / Claude Code surface this.
   */
  readonly attachments?: readonly Attachment[];
}

/** An assistant turn (plain text response). */
export interface AssistantItem extends BaseActivityItem {
  readonly kind: "assistant";
  readonly text: string;
  /** Model id (e.g. `claude-opus-4-5`, `gpt-4-turbo`) when the runtime exposes it. */
  readonly model?: string;
  /**
   * Per-turn token usage when the runtime reports it (Gemini, Codex,
   * Claude Code). Runtimes that only report at session-end (Copilot)
   * leave this undefined and surface aggregates on the
   * {@link SummaryItem} instead.
   */
  readonly tokens?: TokenUsage;
  /**
   * Why the model stopped this turn. Lifted directly from the
   * runtime where exposed (Claude `stop_reason`, Codex
   * `task_complete.reason`); free-string for forwards-compat.
   */
  readonly stopReason?: "end_turn" | "tool_use" | "max_tokens" | "error" | string;
}

/**
 * A reasoning / thinking block. Separate from {@link AssistantItem}
 * so the dashboard can render it collapsed-by-default and the LLM
 * (when consuming activity via MCP) can choose to skip it for token
 * budget reasons.
 */
export interface ThinkingItem extends BaseActivityItem {
  readonly kind: "thinking";
  readonly text: string;
  /**
   * Short headline Gemini exposes per `thoughts[]` entry; absent for
   * runtimes that produce a single undifferentiated trace (Codex,
   * Claude).
   */
  readonly subject?: string;
}

/**
 * A single tool invocation. The runtime adapter is responsible for
 * merging begin/end event pairs (Copilot, Codex) into one item and
 * flipping `status` accordingly. Runtimes that report tool calls
 * inline on the assistant turn (Gemini, Claude Code) emit one item
 * per call, sequenced before the assistant text.
 */
export interface ToolCallItem extends BaseActivityItem {
  readonly kind: "tool_call";
  /** Runtime-native call id, used to merge begin/end pairs. */
  readonly callId: string;
  /** Tool name as reported by the runtime. */
  readonly name: string;
  /** Tool arguments (open-shape; depends on the tool). */
  readonly args?: unknown;
  readonly status: "running" | "success" | "error" | "cancelled";
  /** Tool result payload. Open-shape; consumers render as text/JSON. */
  readonly result?: unknown;
  /**
   * Runtime-supplied rendering hint (Gemini's `resultDisplay` +
   * `renderOutputAsMarkdown`). When present, dashboards SHOULD prefer
   * this over the raw `result` for the collapsed view.
   */
  readonly display?: { readonly content: string; readonly markdown?: boolean };
  /** Wall-clock duration when both begin + end events were observed. */
  readonly durationMs?: number;
}

/**
 * Out-of-band events that don't fit the conversation model:
 * Copilot hooks/skills/subagents, Codex `context_compacted` /
 * `model_reroute`, runtime warnings, etc. `subKind` is the
 * runtime-specific tag so consumers can filter / colour them.
 */
export interface SystemItem extends BaseActivityItem {
  readonly kind: "system";
  readonly text: string;
  readonly level?: "info" | "warn" | "error";
  /**
   * Runtime-specific category. Conventional values (use these when
   * applicable, runtimes are free to add new ones):
   * `"hook"` | `"skill"` | `"subagent"` | `"notification"` |
   * `"context_compacted"` | `"model_change"` | `"warning"`.
   */
  readonly subKind?: string;
}

/**
 * Terminal stats for the task (typically one per task, emitted on
 * session shutdown / task_complete). Optional fields reflect that
 * runtimes report different subsets — consumers render whatever is
 * present.
 */
export interface SummaryItem extends BaseActivityItem {
  readonly kind: "summary";
  /** Free-text summary line if the runtime supplies one. */
  readonly text?: string;
  /**
   * Aggregated token usage for the entire task. Runtimes that
   * already reported tokens per-turn (Gemini, Codex, Claude) sum
   * them; runtimes that only have a session-end count (Copilot)
   * populate it directly here.
   */
  readonly tokens?: TokenUsage;
  readonly stats?: SummaryStats;
}

/**
 * Token usage as a single normalized shape. `total` is required so
 * consumers can render a single number without doing arithmetic;
 * runtimes that only have one number populate `input` and `total`
 * with the same value rather than splitting.
 */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  /** Cache-read tokens (Anthropic / OpenAI). */
  readonly cached?: number;
  /** Reasoning tokens (Codex `reasoning_output_tokens`, OpenAI o1). */
  readonly reasoning?: number;
  readonly total: number;
}

/** Aggregate stats for {@link SummaryItem.stats}. All fields optional. */
export interface SummaryStats {
  readonly filesModified?: readonly string[];
  readonly linesAdded?: number;
  readonly linesRemoved?: number;
  readonly toolCallsCount?: number;
  readonly durationMs?: number;
  /** Pre-computed cost when the runtime exposes one (Claude Code). */
  readonly costUSD?: number;
  /** Last-seen model id (Copilot, Codex). */
  readonly model?: string;
  /** "Premium" / billable request count (Copilot-specific, generalisable). */
  readonly premiumRequests?: number;
}

/**
 * Multi-modal payload attached to a {@link UserItem}. Either `url`
 * or `data` is present; both convey the same image/file but via
 * different transport (URL reference vs base64 inline).
 */
export interface Attachment {
  readonly kind: "image" | "file";
  readonly mimeType?: string;
  readonly url?: string;
  /** Base64-encoded inline payload. */
  readonly data?: string;
  /** Display name (filename without path). */
  readonly name?: string;
}
