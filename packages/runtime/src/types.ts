/**
 * Minimal resolved-agent shape consumed by runtime adapters during
 * {@link Runtime.provision}. Defined here (not imported from
 * `@emploke/catalog`) so this package depends on the catalog only by
 * structural typing — any object satisfying this shape works.
 *
 * `@emploke/catalog`'s `ResolvedAgent` is a superset of this
 * type; passing it through as-is type-checks via structural
 * compatibility.
 */
export interface ResolvedAgent {
  readonly agent: { readonly fqn: string };
  readonly skills: readonly { readonly skill: { readonly fqn: string } }[];
  readonly mcps: readonly { readonly fqn: string }[];
}

/**
 * Minimal capability surface a content provider must implement for
 * runtime adapters to materialise a workdir. `AgentContentSource` from
 * `@emploke/catalog` satisfies this interface; runtime never imports
 * from catalog.
 */
export interface AgentContentSource {
  resolveAgent(fqn: string): Promise<ResolvedAgent>;
  agentEntries(fqn: string): AsyncIterable<{ relPath: string; content: Buffer }>;
  skillEntries(fqn: string): AsyncIterable<{ relPath: string; content: Buffer }>;
  /**
   * MCP spec as a parsed JSON object, ready to embed under
   * `mcpServers` in the target CLI's config. Emploke's internal
   * `_meta` block is stripped by the content source — runtime does
   * NOT need to know catalog's storage format.
   */
  getMcpRuntimeConfig(fqn: string): Promise<Record<string, unknown>>;
}

/**
 * A Runtime adapts a third-party CLI (Copilot, Gemini, Claude Code, …) for use
 * by emploke. The interface is **domain-agnostic** — it does NOT import
 * emploke's `Session` or `Task` value types and exposes no method named after
 * either. It surfaces two execution modes plus a shared
 * observability + maintenance surface that both modes consume:
 *
 *   ## Interactive mode (`-i`)
 *   - {@link provision}: bake an agent into a workdir
 *   - {@link buildInteractiveLaunch}: build the shell command that drops the user into the CLI
 *
 *   ## Non-interactive mode (`-p`)
 *   - {@link launchHeadless} (optional): spawn the CLI as a detached worker that
 *     consumes a prompt and exits when done
 *
 *   ## Observability — works for either mode
 *   - {@link readMetadata}: title / lastActiveAt / userTitled, by `runtimeSessionId`
 *   - {@link readActivity}: paginated parsed timeline
 *   - {@link streamActivity}: live tail of the timeline
 *
 *   ## Maintenance — works for either mode
 *   - {@link deleteState}: remove the runtime's recorded state for one
 *     `runtimeSessionId`
 *
 * Runtimes are stateless across calls. Per-conversation data lives either
 * keyed by an opaque `runtimeSessionId` (string) or in the CLI's own
 * storage. The manager layer (`@emploke/session`, `@emploke/task`) is the
 * one that understands "session" vs "task" and translates those domain
 * concepts into runtime calls — to the runtime it's all just one thing
 * with two start modes.
 *
 * Why this split: a session and a task are, from the runtime's perspective,
 * the same thing — a `runtimeSessionId` that points at a CLI-managed
 * conversation. The execution mode (`-i` interactive vs `-p` headless) is
 * the only distinction the runtime actually sees.
 */
export interface Runtime {
  /**
   * Stable identifier for this runtime, used as the `RuntimeRegistry`
   * lookup key and persisted by managers. Conventionally the CLI's
   * canonical name in lowercase: `"copilot"`, `"gemini"`, `"claude-code"`.
   */
  readonly kind: string;

  /**
   * Optional capability flags advertised to the rest of the system.
   * Absent or `undefined` means "baseline-only". Surfaced through the
   * server's `/api/runtimes` endpoint so the dashboard can disable UI
   * affordances that map to capabilities the active runtime doesn't
   * support — see {@link RuntimeCapabilities}.
   */
  readonly capabilities?: RuntimeCapabilities;

  // ─── Interactive mode (-i) ─────────────────────────────────────────

  /**
   * Bake `agent` into `workdir` so the CLI can be launched against it.
   *
   * The returned `runtimeSessionId` becomes the binding between this
   * conversation and the CLI's notion of a session:
   *
   *  - **Pre-allocating runtimes** (e.g. Copilot, which accepts
   *    `--session-id=<arbitrary-uuid>` and creates the session if missing)
   *    return a freshly-minted id here. Subsequent {@link buildInteractiveLaunch}
   *    calls always pass `--session-id=<that-id>`.
   *  - **Discovery-only runtimes** (e.g. Gemini, where the id is minted
   *    by the CLI at first launch and must be scraped from logs / fs /
   *    stdout afterwards) return `null`. The id will be filled in later
   *    by the manager calling {@link readMetadata}.
   *
   * `workdir` is guaranteed to exist and be empty. Provision is *not*
   * required to be idempotent; the caller arranges atomicity (rolling
   * back the workdir on failure).
   */
  provision(
    workdir: string,
    agent: ResolvedAgent,
    catalog: AgentContentSource,
    ctx: ProvisionContext,
  ): Promise<{
    runtimeSessionId: string | null;
  }>;

  /**
   * Build the shell incantation that drops the user into an interactive
   * CLI session. Inspects `runtimeSessionId` to decide whether to
   * include a resume flag.
   *
   * `runtimeSessionId` is `null` when no resume is desired (fresh launch
   * for a discovery-only runtime, or a session that's never been
   * provisioned with a pre-allocated id). Otherwise the runtime SHOULD
   * include `--session-id=<id>` (or its CLI's equivalent).
   *
   * `workdir` is the directory the CLI should be launched in (becomes
   * the returned {@link LaunchCommand.cwd}). Distinct from
   * `workspaceDir` because a single workspace can host many
   * conversations; this is the per-conversation one.
   *
   * `workspaceDir` is the absolute path of the workspace this
   * conversation belongs to. Runtimes are free to ignore it; CLIs
   * whose interactive mode requires a per-launch precondition keyed
   * off the workspace root (e.g. Copilot needs an entry in
   * `~/.copilot/config.json` `trustedFolders`) use it to perform
   * that precondition here, lazily, only when the user actually launches.
   *
   * `opts` carries per-launch flags. Runtimes that don't implement a
   * flag MUST throw a typed error when asked for it (see
   * {@link RuntimeCapabilities}); they MUST NOT silently ignore an
   * unsupported flag.
   */
  buildInteractiveLaunch(
    runtimeSessionId: string | null,
    workdir: string,
    workspaceDir: string,
    opts?: BuildInteractiveLaunchOpts,
  ): Promise<LaunchCommand>;

  // ─── Non-interactive mode (-p) ─────────────────────────────────────

  /**
   * Optional. Spawn the CLI non-interactively to consume `opts.prompt`
   * unattended (Copilot's `-p`/`--prompt`, etc.). Runtimes whose
   * underlying CLI doesn't support a headless mode simply omit this
   * method; the manager surfaces a clear "this CLI can't run autonomous
   * tasks" error rather than letting `launchHeadless is not a function`
   * leak through.
   *
   * The runtime owns the subprocess for the life of the call: it picks
   * CLI flags appropriate for unattended execution (allow-all-tools,
   * disable user prompts, structured output where available), wires up
   * its own stderr capture, and returns a {@link RuntimeHandle} so the
   * caller can observe completion without holding the spawn machinery
   * itself.
   */
  launchHeadless?(opts: LaunchHeadlessOpts): Promise<RuntimeHandle>;

  // ─── Observability ─────────────────────────────────────────────────

  /**
   * Optional. Read runtime-managed display metadata for one
   * `runtimeSessionId` — principally a `title` field that the CLI
   * generates from the first user prompt (Copilot's
   * `workspace.yaml.name`). Works for either execution mode.
   *
   * Returns `null` when the runtime has no record of the id (CLI
   * hasn't launched yet, state was deleted out of band, runtime
   * doesn't expose display metadata at all).
   *
   * Implementations should be idempotent and side-effect-free.
   */
  readMetadata?(runtimeSessionId: string): Promise<RuntimeSessionMetadata | null>;

  /**
   * Optional. Fetch the runtime-neutral activity timeline for one
   * `runtimeSessionId` — end-to-end:
   *
   *   1. Locate the runtime-native event log for this id
   *   2. Read it (with safety caps) and parse
   *   3. Translate to the shared {@link ActivityItem} vocabulary
   *   4. Pick the agent's "final answer" string for the headline
   *
   * Returns `null` when the runtime has no log for this id yet.
   * Throws on real I/O / parse errors so the route layer can surface
   * 5xx for genuine faults.
   *
   * Tail-first pagination via `opts.before` / `opts.after` (mutually
   * exclusive) + `opts.limit`; omit both for the latest `limit` items
   * (tail). Items themselves are the cursor — `seq` is monotonic per
   * log; consumers derive `hasOlder` / `hasNewer` from
   * `activity[0].seq > 0` and `activity[last].seq < totalItems - 1`.
   * Truncation surfaces in {@link TruncationInfo}; consumers MUST
   * surface it so the user doesn't render a partial timeline as if
   * it were complete.
   */
  readActivity?(opts: ReadActivityOpts): Promise<ActivityResult | null>;

  /**
   * Optional. Live-tail variant of {@link readActivity}. Returns an
   * AsyncIterable that yields {@link ActivityItem}s as they're
   * written to the runtime's native log, until the iterator is closed.
   *
   * Used by the SSE `/activity/stream` endpoint to push live events
   * to the dashboard.
   *
   * Cleanup contract: when `opts.signal` aborts, the iterator MUST
   * stop within a few hundred ms and release any file handles.
   */
  streamActivity?(opts: StreamActivityOpts): AsyncIterable<ActivityItem>;

  // ─── Maintenance ───────────────────────────────────────────────────

  /**
   * Remove the runtime's recorded state for one `runtimeSessionId`.
   * No-op when no state exists.
   *
   * Throws on partial failure (e.g. permission denied removing some
   * files); the caller is responsible for surfacing this to the user.
   * Both `SessionService.delete({purge:true})` and
   * `TaskService.delete({purge:true})` call this — runtime first, so
   * a runtime failure aborts before any local removal.
   */
  deleteState(runtimeSessionId: string): Promise<void>;
}

/**
 * Cross-runtime context handed to {@link Runtime.provision}. Keeps the
 * positional arg list short while leaving room for future per-call
 * fields without churning every runtime adapter.
 */
export interface ProvisionContext {
  /** Absolute path of the workspace this conversation belongs to. */
  readonly workspaceDir: string;
}

/**
 * Per-launch flags handed to {@link Runtime.buildInteractiveLaunch}. Each field
 * maps to a user-facing affordance the dashboard exposes (typically as
 * a separate spawn button). Runtimes that don't support a flag MUST
 * throw — see the per-flag note for the right error class.
 */
export interface BuildInteractiveLaunchOpts {
  /**
   * If `true`, the launch should enable remote control of the
   * interactive session. For Copilot this maps to the CLI's `--remote`
   * flag.
   *
   * The dashboard only surfaces a "Spawn remote" button when the
   * active runtime advertises `capabilities.remoteSession === true`;
   * the runtime MUST still defend itself by throwing
   * {@link RuntimeDoesNotSupportRemoteError} when called with
   * `{ remote: true }` on a runtime that doesn't support it.
   */
  readonly remote?: boolean;
}

/**
 * Optional capability flags advertised by a {@link Runtime}. Each flag
 * is a public guarantee about a specific behaviour the runtime
 * implements; the absence of a flag means the runtime makes no claim
 * either way (and in practice doesn't support it).
 */
export interface RuntimeCapabilities {
  /**
   * Whether {@link Runtime.buildInteractiveLaunch} supports `opts.remote = true`.
   * When `true`, calling buildInteractiveLaunch with `{ remote: true }` produces
   * a launch that puts the underlying CLI into remote-control mode.
   */
  readonly remoteSession?: boolean;
}

/**
 * Inputs to {@link Runtime.launchHeadless}. `workdir` is guaranteed to exist
 * and doubles as the subprocess `cwd`; the caller is responsible for
 * laying down whatever the agent needs there before invoking launchHeadless
 * (typically by calling {@link Runtime.provision} on the same dir
 * first).
 *
 * `catalog` carries the byte-source for skill / agent / mcp content,
 * see the docstring on {@link Runtime.provision} for rationale.
 *
 * `workspaceDir` lets the runtime resolve `${workspaceDir}`
 * placeholders in MCP / agent specs the same way `provision` does.
 */
export interface LaunchHeadlessOpts {
  readonly workdir: string;
  readonly agent: ResolvedAgent;
  readonly catalog: AgentContentSource;
  readonly prompt: string;
  readonly workspaceDir: string;
  /**
   * Extra environment variables merged into the spawned subprocess on
   * top of the server's own `process.env`. Used to give every emploke-
   * controlled child a self-describing context bag (`EMPLOKE_WORKSPACE`,
   * `EMPLOKE_WORKSPACE_DIR`, `EMPLOKE_WORK_KIND`, `EMPLOKE_WORK_ID`,
   * `EMPLOKE_WORK_DIR`, `EMPLOKE_SERVER`, `EMPLOKE_SHARED_DIR`).
   *
   * Why this exists: AI-agent harnesses run each tool call in a fresh
   * shell, so per-shell `export EMPLOKE_WORKSPACE=...` does not survive.
   * Threading the bag through the runtime contract means the very
   * binary the agent shells out to (e.g. `emploke task dispatch`)
   * inherits the workspace identity automatically; no setup step
   * required, no chance of operating on the wrong workspace because
   * the env was rebuilt mid-conversation.
   *
   * Keys with `undefined` values are dropped (matches Node's spawn
   * convention); pass `undefined` from the caller to "don't set this
   * variable" without having to branch on whether it exists upstream.
   */
  readonly subprocessEnv?: NodeJS.ProcessEnv;
}

/**
 * Live handle to a headless (`-p` mode) subprocess. Returned
 * synchronously (via Promise) from {@link Runtime.launchHeadless} once the
 * subprocess is up; the caller awaits `exit` for terminal status and
 * may consult `sessionDir` to mount the runtime's native log
 * directory.
 *
 * **Why `sessionDir` is a Promise** rather than a sync `string | null`:
 * a headless subprocess is owned by the runtime *now*, so it can
 * naturally produce a future value for any id/path it learns
 * post-spawn. Interactive sessions are launched by a human at some
 * unknown later time, so the runtime can't promise anything; the
 * manager discovers the id later via {@link Runtime.readMetadata}.
 */
export interface RuntimeHandle {
  /**
   * Id the runtime minted for the underlying CLI session/state.
   * Optional because only pre-allocating runtimes (Copilot) know it
   * up front; discovery-only runtimes leave it undefined.
   *
   * Persisted by callers (TaskService / SessionService) so observability
   * methods (`readActivity`, `readMetadata`, etc.) can reference it
   * later, plus drive the underlying CLI directly
   * (e.g. `copilot --session-id=<id>`).
   */
  readonly runtimeSessionId?: string;

  /**
   * Where the runtime is writing its native per-session log directory
   * for this headless launch. The runtime owns reads against this directory
   * end-to-end via {@link Runtime.readActivity} (and removal via
   * {@link Runtime.deleteState}).
   */
  readonly sessionDir: Promise<string>;

  /**
   * Resolves when the subprocess exits. `code` is `null` if the
   * process was terminated by a signal (in which case `signal`
   * carries it); `signal` is `null` for a normal exit.
   */
  readonly exit: Promise<RuntimeExit>;

  /**
   * Best-effort terminate. Sends SIGTERM (or the platform equivalent);
   * the caller awaits `exit` to confirm termination.
   */
  kill(): void;
}

export interface RuntimeExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Runtime-supplied display metadata. Returned by
 * {@link Runtime.readMetadata}. The same shape regardless of whether
 * the underlying conversation was started via `-i` interactive or `-p`
 * headless launch — the runtime stores them the same way.
 */
export interface RuntimeSessionMetadata {
  /**
   * Short user-facing label generated by the runtime CLI (typically
   * 5-7 words summarising the user's first prompt). `null` when the
   * runtime hasn't produced one yet or when the source field is empty.
   */
  readonly title: string | null;
  /**
   * True when the user has explicitly renamed the session via the
   * runtime CLI's rename command (Copilot's `user_named: true`).
   * Consumers MUST NOT overwrite the title in this case.
   */
  readonly userTitled: boolean;
  /**
   * Last-active ISO timestamp from the runtime's own clock.
   */
  readonly lastActiveAt: string | null;
}

/** Inputs to {@link Runtime.readActivity}. */
export interface ReadActivityOpts {
  /** The runtime session id to read activity for. */
  readonly runtimeSessionId: string;
  /**
   * Forward pagination: return only items with `seq > after`. Used by
   * SSE polling and by callers walking the timeline head-to-tail.
   *
   * Mutually exclusive with {@link before}; supplying both is a
   * `RuntimeReadActivityInvalidArgs` from the runtime layer (the route
   * layer should reject as 400 before reaching the runtime).
   */
  readonly after?: number;
  /**
   * Backward pagination: return only items with `seq < before`. Used
   * by GUI consumers loading older history when the user scrolls up
   * past the initial tail-window.
   *
   * Returns the LATEST `limit` items below the cut (i.e., the chunk
   * immediately preceding `before`), still sorted by `seq` ASC for
   * caller convenience.
   */
  readonly before?: number;
  /**
   * Maximum number of items to return. Server enforces a default
   * (50) and a hard maximum (500) before calling into the runtime.
   *
   * Default-tail semantics: when neither {@link after} nor
   * {@link before} is set, the runtime returns the LATEST `limit`
   * items overall (the tail). This is what GUI initial loads want;
   * a CLI walking the full history starts from `after = -1` and
   * loops until the response is empty.
   */
  readonly limit?: number;
}

/** Inputs to {@link Runtime.streamActivity}. */
export interface StreamActivityOpts {
  /** The runtime session id to stream activity for. */
  readonly runtimeSessionId: string;
  /**
   * Resume from this seq number (exclusive) — i.e. the stream
   * yields items with `seq > after`. Used by SSE reconnection
   * (the server reads `Last-Event-ID` and forwards it here). When
   * omitted, the stream starts from the next event written to
   * the log — it does NOT replay history. Forward-only by design;
   * use {@link Runtime.readActivity}'s `before` for backward paging.
   */
  readonly after?: number;
  /**
   * Caller's abort signal. The runtime MUST stop tailing and clean
   * up file handles / watchers when this fires.
   */
  readonly signal?: AbortSignal;
}

/**
 * Bundled result returned by {@link Runtime.readActivity}: the
 * filtered timeline plus the derived headline answer the dashboard
 * renders prominently. `result` is `null` when the agent never
 * produced a final assistant message.
 *
 * Pagination + truncation:
 *
 * - `activity` is `seq`-ASC sorted regardless of which direction
 *   was requested. Items themselves are the cursor — there is no
 *   separate `cursor` / `nextCursor` field. Callers derive
 *   `hasOlder` / `hasNewer` from `activity[0].seq > 0` and
 *   `activity[last].seq < totalItems - 1`.
 * - `totalItems` is authoritative for the WHOLE log (not just the
 *   page) so consumers can compute window position + scrollbar
 *   density without an extra round-trip.
 * - `truncated` is non-null when the runtime had to drop bytes /
 *   items to stay within the safety cap.
 */
export interface ActivityResult {
  readonly activity: readonly ActivityItem[];
  readonly result: string | null;
  /**
   * Total items in the underlying log. Always present so that GUI
   * consumers can compute `hasOlder` / `hasNewer` from the page
   * window (`activity[0].seq > 0` and
   * `activity[last].seq < totalItems - 1`) without needing
   * dedicated cursor fields. Authoritative for the WHOLE log even
   * when truncation dropped some items from the page.
   */
  readonly totalItems: number;
  readonly truncated?: TruncationInfo;
}

/**
 * Why and how an {@link ActivityResult} was truncated. Always present
 * when truncation happened; absent when the response is the complete
 * timeline.
 */
export interface TruncationInfo {
  /**
   * `"size_limit"` — runtime hit a raw byte cap reading the log.
   * `"page_limit"` — caller's `limit` was smaller than available items.
   */
  readonly reason: "size_limit" | "page_limit";
  /** Bytes dropped from the start of the source file (size_limit only). */
  readonly droppedBytes?: number;
  /** Items dropped from the start (size_limit only). */
  readonly droppedItems?: number;
  /** Hint string for the LLM when this response is consumed via MCP. */
  readonly hint?: string;
}

/**
 * A shell-runnable launch command, returned by
 * {@link Runtime.buildInteractiveLaunch}. The `cmd`/`args`/`cwd` triple is suitable
 * for `child_process.spawn`; `display` is a single-line string suitable
 * for displaying to the user or copying to the clipboard.
 */
export interface LaunchCommand {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly display: string;
  /**
   * Optional env vars the spawned terminal session should inherit.
   *
   * Why this exists: tasks are spawned directly by the server so we
   * can pass `env` straight to `child_process.spawn`. Sessions are
   * spawned indirectly via the user's terminal app (Windows Terminal
   * / Terminal.app / gnome-terminal), most of which run as long-lived
   * daemons that do NOT see the env we hand to their launcher
   * process. Reliably propagating env to the shell that ends up
   * exec'ing this command therefore requires INLINING the env into
   * the shell command itself (`export K='v' && exec foo args` on
   * POSIX, `$env:K='v'; & foo args` for pwsh). The terminal package
   * does that work; this field carries the bag from
   * `SessionService.buildInteractiveLaunch` to `spawnTerminal`.
   *
   * Values must be plain strings — no `undefined` (semantically
   * meaningless when inlining), no `null`, no arrays. `undefined`
   * upstream should be filtered before assembling this map.
   */
  readonly env?: Readonly<Record<string, string>>;
}

// ─── ActivityItem (cross-runtime structured timeline) ─────────────────

/**
 * Runtime-neutral entries returned inside {@link ActivityResult} by
 * {@link Runtime.readActivity}, and yielded by
 * {@link Runtime.streamActivity}.
 *
 * Discriminated union covering the cross-runtime semantic primitives
 * observed in Copilot, Gemini, OpenAI Codex, and Claude Code:
 *
 *   - `user` — what the user asked, plus optional attachments
 *   - `assistant` — what the agent answered (plain text only — tool
 *     calls live in their own items); optional model + tokens
 *   - `thinking` — agent reasoning trace
 *   - `tool_call` — a single tool invocation
 *   - `system` — out-of-band events
 *   - `summary` — terminal stats; typically once per conversation
 *
 * Every item carries a monotonic `seq` (per conversation) — the
 * canonical cursor for pagination and SSE reconnection. `id` is the
 * runtime-native UUID when available; `parentSeq` is optional
 * threading metadata.
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
   * Monotonic per-conversation sequence number. The canonical cursor
   * for pagination and SSE `Last-Event-ID` reconnection.
   */
  readonly seq: number;
  /** Runtime-native stable id when available. */
  readonly id?: string;
  /** Sequence number of the item this one logically follows. */
  readonly parentSeq?: number;
  /** ISO 8601 UTC timestamp the runtime recorded for this event. */
  readonly timestamp: string;
}

/** A user turn (prompt + optional attachments). */
export interface UserItem extends BaseActivityItem {
  readonly kind: "user";
  readonly text: string;
  readonly attachments?: readonly Attachment[];
}

/** An assistant turn (plain text response). */
export interface AssistantItem extends BaseActivityItem {
  readonly kind: "assistant";
  readonly text: string;
  readonly model?: string;
  readonly tokens?: TokenUsage;
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
  readonly subject?: string;
}

/**
 * A single tool invocation. The runtime adapter is responsible for
 * merging begin/end event pairs into one item and flipping `status`
 * accordingly.
 */
export interface ToolCallItem extends BaseActivityItem {
  readonly kind: "tool_call";
  readonly callId: string;
  readonly name: string;
  readonly args?: unknown;
  readonly status: "running" | "success" | "error" | "cancelled";
  readonly result?: unknown;
  readonly display?: { readonly content: string; readonly markdown?: boolean };
  readonly durationMs?: number;
}

/**
 * Out-of-band events that don't fit the conversation model.
 * `subKind` is the runtime-specific tag so consumers can filter.
 */
export interface SystemItem extends BaseActivityItem {
  readonly kind: "system";
  readonly text: string;
  readonly level?: "info" | "warn" | "error";
  readonly subKind?: string;
}

/**
 * Terminal stats for the conversation (typically one per task,
 * emitted on session shutdown / task complete).
 */
export interface SummaryItem extends BaseActivityItem {
  readonly kind: "summary";
  readonly text?: string;
  readonly tokens?: TokenUsage;
  readonly stats?: SummaryStats;
}

/**
 * Token usage as a single normalized shape.
 *
 * `output` is the only required field — it's reliably present on
 * per-message events from every shipping runtime adapter (Copilot
 * `assistant.message.outputTokens`, etc.) and in session shutdown
 * aggregates.
 *
 * `input` and `total` are optional because per-message events from
 * Copilot's NDJSON log don't carry an input token count; only the
 * session shutdown's `modelMetrics.usage.inputTokens` aggregate does.
 * Earlier code papered over this by lying about `input: 0`, which
 * meant `total` was wrong and downstream `input + output > 0` checks
 * were perpetually true. Consumers should treat `input === undefined`
 * as "not measured at this granularity" and either omit the input
 * column from rendering or render `?`/`—`.
 *
 * `cached`, `cacheWrite`, and `reasoning` are optional add-ons emitted
 * when the upstream provides per-class breakdown:
 *  - `cached` = Anthropic prompt-cache READ (charged ~10× cheaper than
 *    fresh input, often >90% of `input` on long sessions)
 *  - `cacheWrite` = prompt-cache WRITE (charged ~1.25× input on the
 *    one-time creation)
 *  - `reasoning` = extended-thinking output tokens (counted toward
 *    `output` totals upstream but billed and surfaced separately so
 *    operators can see how much was spent thinking vs replying)
 *
 * Always opt-in; absent ≢ zero.
 */
export interface TokenUsage {
  readonly input?: number;
  readonly output: number;
  readonly cached?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
  readonly total?: number;
}

/** Aggregate stats for {@link SummaryItem.stats}. All fields optional. */
export interface SummaryStats {
  readonly filesModified?: readonly string[];
  readonly linesAdded?: number;
  readonly linesRemoved?: number;
  readonly toolCallsCount?: number;
  readonly durationMs?: number;
  readonly costUSD?: number;
  readonly model?: string;
  readonly premiumRequests?: number;
}

/**
 * Multi-modal payload attached to a {@link UserItem}. Either `url` or
 * `data` is present.
 */
export interface Attachment {
  readonly kind: "image" | "file";
  readonly mimeType?: string;
  readonly url?: string;
  readonly data?: string;
  readonly name?: string;
}
