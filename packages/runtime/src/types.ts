import type { AgentResolveResult } from "@emploke/catalog";

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
   */
  provision(
    workdir: string,
    agent: AgentResolveResult,
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
   */
  buildLaunch(session: Session): LaunchCommand;

  /**
   * Remove the CLI's recorded state for `session`. No-op if no state exists.
   * Throws on partial failure (e.g. permission denied removing some files);
   * the caller is responsible for surfacing this to the user.
   */
  deleteState(session: Session): Promise<void>;

  /**
   * Optional one-time setup step performed against a workspace root rather
   * than a per-session workdir. Called by the server when a workspace is
   * first opened (and again on subsequent server bootstraps; implementations
   * MUST be idempotent).
   *
   * Use cases:
   *  - record the workspace as trusted with the CLI so spawned sessions
   *    don't trigger per-folder trust prompts (Copilot)
   *  - register a workspace-level config, project token, etc.
   *
   * Runtimes with no workspace-level setup omit this method entirely.
   * Failures should be wrapped in `RuntimeRegisterWorkspaceFailed` by the
   * caller (the runtime can throw any error; the registry adapter wraps).
   */
  registerWorkspace?(workspaceDir: string): Promise<void>;
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
