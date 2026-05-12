import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";
import {
  RuntimeDoesNotSupportRemoteError,
  RuntimeProvisionFailed,
  RuntimeRefreshFailed,
  RuntimeStateDeletionFailed,
} from "../errors.js";
import type { PlaceholderContext } from "../placeholders.js";
import type {
  BuildLaunchOpts,
  LaunchCommand,
  ProvisionContext,
  Runtime,
  RuntimeCapabilities,
  Session,
  TaskActivityOpts,
  TaskActivityResult,
  TaskHandle,
} from "../types.js";
import { deriveCopilotResult, parseCopilotActivity } from "./activity.js";
import {
  type DispatchCopilotTaskDeps,
  type DispatchCopilotTaskOpts,
  dispatchCopilotTask,
} from "./dispatch-task.js";
import { generateCopilotSessionId, isCopilotSessionId } from "./ids.js";
import { buildCopilotLaunchCommand } from "./launch.js";
import { provisionCopilotWorkdir } from "./provision.js";
import { readCopilotSessionState } from "./state.js";
import { ensureDirTrusted } from "./trust.js";

const DEFAULT_COPILOT_STATE_DIR = path.join(homedir(), ".copilot", "session-state");
const DEFAULT_COPILOT_CONFIG_PATH = path.join(homedir(), ".copilot", "config.json");
const DEFAULT_GLOBAL_DIR = path.join(homedir(), ".emploke", "shared");

export interface CopilotRuntimeConfig {
  /**
   * Override the directory where copilot stores per-session state. Defaults
   * to `~/.copilot/session-state`. Tests pass a tmp dir; production callers
   * normally leave this unset.
   */
  readonly copilotStateDir?: string;
  /**
   * Override the Copilot CLI config file we maintain `trustedFolders` in.
   * Defaults to `~/.copilot/config.json` — NOT `settings.json`. The Copilot
   * CLI (verified against 1.0.44) only reads trust state from
   * `config.json`; entries written to `settings.json.trustedFolders` are
   * silently ignored, even though the leading comment in `config.json`
   * misleadingly says "User settings belong in settings.json".
   *
   * Tests pass a tmp path so the real user config file is never mutated.
   *
   * Used exclusively by `buildLaunch` (interactive mode preflight); per-
   * session `provision` and per-task `dispatchTask` do NOT touch this
   * file (see class jsdoc for the per-mode trust matrix).
   */
  readonly copilotConfigPath?: string;
  /**
   * Override the directory exposed to spec authors as `${globalDir}` in
   * placeholder substitution. Defaults to `~/.emploke/shared`. Server
   * bootstrap normally derives this from `EMPLOKE_HOME` and passes it
   * explicitly so the value tracks any `EMPLOKE_HOME` override.
   *
   * Per-workspace state should NOT live here — spec authors use
   * `${workspaceDir}` for that. This dir is for state that is shared
   * across every workspace + session + task on the machine
   * (e.g. one playwright login the user wants every project to reuse).
   */
  readonly globalDir?: string;
  /**
   * Test seam for id generation. Defaults to `crypto.randomUUID`.
   */
  readonly randomUUID?: () => string;
  /**
   * Optional injection of the dispatch dependencies. Production callers
   * leave this unset; tests pass a stub spawn / mkdir to avoid actually
   * launching the CLI. `copilotStateDir` and `randomUUID` here, if
   * provided, override the top-level options for dispatch only.
   */
  readonly dispatchDeps?: Partial<DispatchCopilotTaskDeps>;
}

/**
 * The Copilot adapter. Pre-allocates a UUID at provision time and threads it
 * through `--resume=<id>` on every launch, so first launch creates the session
 * and subsequent launches resume it. This eliminates the cwd-join logic the
 * old implementation needed (where copilot minted ids and we had to scan all
 * sessions and match by cwd).
 *
 * # Trust handling — per-mode (Copilot-specific, intentionally NOT abstracted)
 *
 * Trust resolution differs between Copilot's two execution modes; this is
 * a property of the Copilot CLI itself and is intentionally NOT lifted
 * into the cross-runtime `Runtime` interface. Each runtime adapter owns
 * its own preconditions and decides where in its lifecycle to enforce
 * them. There is no `registerWorkspace`-style hook on `Runtime`.
 *
 * Empirically verified against Copilot CLI 1.0.44:
 *
 *   | mode                | folder-trust gate?           | how to satisfy                |
 *   |---------------------|------------------------------|-------------------------------|
 *   | `-i` (interactive)  | yes — `cwd` (or an ancestor) | write `cwd` (or an ancestor)  |
 *   |  i.e. `buildLaunch` |   must be in                 |   to `~/.copilot/config.json` |
 *   |                     |   `config.json.trustedFolders` |  `trustedFolders`           |
 *   |                     |   else CLI shows blocking    |                               |
 *   |                     |   "Confirm folder trust"     |                               |
 *   |                     |   prompt                     |                               |
 *   |---------------------|------------------------------|-------------------------------|
 *   | `-p --yolo`         | none                         | nothing — `--yolo` (which     |
 *   |  i.e. `dispatchTask`|   (verified: even cross-     |   includes `--allow-all-paths`)|
 *   |                     |    drive absolute paths      |   bypasses the gate entirely  |
 *   |                     |    work with empty           |                               |
 *   |                     |    `trustedFolders`)         |                               |
 *
 * Two notes on the table:
 *
 * - The trust file is `config.json`, NOT `settings.json`. The leading
 *   comment in `config.json` says "User settings belong in settings.json.
 *   This file is managed automatically." — that comment is misleading for
 *   `trustedFolders` specifically: the CLI only reads trust from
 *   `config.json`, regardless of where the user writes it. Verified by
 *   placing identical entries in both files and observing that only the
 *   `config.json` entry suppresses the prompt.
 *
 * - `--add-dir` is NOT an alternative for `-i` mode (it's a file-access
 *   allowlist for `--allow-all-paths`-style flows; it does not pre-trust
 *   the folder for the interactive trust gate). So per-session
 *   `--add-dir` shims do not work as a transient. The only working knob
 *   for `-i` is the persistent `config.json` entry.
 *
 * Concretely, `buildLaunch(session, workspaceDir)` ensures `workspaceDir`
 * is covered by `config.json.trustedFolders` immediately before returning
 * the launch spec — so trust I/O happens at the moment the user actually
 * launches an interactive session, not eagerly when the workspace is
 * registered. The write is idempotent and ancestor-aware: the first
 * launch in a workspace pays one read+write; every subsequent launch
 * passes `isPathCovered` and short-circuits without writing. `dispatchTask`
 * never touches the file because `-p --yolo` does not need trust.
 *
 * SECURITY: every method that would compose `runtimeSessionId` into a
 * filesystem path or a `--resume=<id>` argument runs it through
 * `isCopilotSessionId` first. A tampered `session.json` with a malicious id
 * (e.g. `"../../etc"` for path-traversal, or one with shell metacharacters
 * for the display string) is treated as if the id were null — refresh
 * returns "no activity", deleteState is a no-op, and buildLaunch produces a
 * fresh launch (no --resume). That degrades gracefully for the user and
 * keeps the surface immune to malformed persisted state.
 */
export class CopilotRuntime implements Runtime {
  readonly kind = "copilot";

  /**
   * Capabilities Copilot's CLI implements that other runtimes might
   * not. Read by the server's `/api/runtimes` route → surfaced in the
   * dashboard so the "Spawn remote" button only renders enabled when
   * the active runtime supports it.
   *
   * - `remoteSession`: Copilot CLI 1.0.44+ accepts `--remote` to bridge
   *   the interactive session to a browser / mobile app via GitHub. See
   *   {@link buildLaunch} for the per-launch wiring.
   */
  readonly capabilities: RuntimeCapabilities = {
    remoteSession: true,
  };

  private readonly copilotStateDir: string;
  private readonly copilotConfigPath: string;
  private readonly globalDir: string;
  private readonly randomUUID: () => string;
  private readonly dispatchDeps: Partial<DispatchCopilotTaskDeps>;

  constructor(config: CopilotRuntimeConfig = {}) {
    this.copilotStateDir = config.copilotStateDir ?? DEFAULT_COPILOT_STATE_DIR;
    this.copilotConfigPath = config.copilotConfigPath ?? DEFAULT_COPILOT_CONFIG_PATH;
    this.globalDir = config.globalDir ?? DEFAULT_GLOBAL_DIR;
    this.randomUUID = config.randomUUID ?? (() => generateCopilotSessionId());
    this.dispatchDeps = config.dispatchDeps ?? {};
  }

  async provision(
    workdir: string,
    agent: AgentResolveResult,
    catalog: CatalogManager,
    ctx: ProvisionContext,
  ): Promise<{ runtimeSessionId: string }> {
    const placeholders: PlaceholderContext = {
      workspaceDir: ctx.workspaceDir,
      globalDir: this.globalDir,
    };
    try {
      await provisionCopilotWorkdir(workdir, agent, catalog, placeholders);
    } catch (err) {
      throw new RuntimeProvisionFailed(this.kind, workdir, err as Error);
    }
    const runtimeSessionId = generateCopilotSessionId(this.randomUUID);
    return { runtimeSessionId };
  }

  /**
   * Build the launch incantation for an interactive Copilot session.
   *
   * Preflight side-effect: writes `workspaceDir` (idempotently, with
   * ancestor coverage) into `~/.copilot/config.json` `trustedFolders`
   * via `ensureDirTrusted`. This is the per-mode trust handling the
   * class jsdoc describes — it is intentionally NOT exposed as a
   * cross-runtime `Runtime` method, because trust shape varies across
   * CLIs. The first launch in a workspace pays one read+write; every
   * subsequent launch hits the "already covered" early return and
   * performs only a cheap read.
   *
   * If the trust write fails, the launch fails (`TrustRegistrationFailed`
   * propagates). That is the right behaviour: spawning Copilot anyway
   * would just stall on the blocking "Confirm folder trust" prompt
   * inside the freshly-spawned terminal, which is much worse UX than a
   * surfaced error in the dashboard.
   *
   * Pure (no I/O) on the runtimeSessionId branch: a tampered or absent
   * id falls through to `buildCopilotLaunchCommand` with a `null` id,
   * producing a fresh-launch form (no `--resume`). The trust write
   * still runs; that is not a security concern because workspaceDir is
   * controlled by the caller (server, not user input).
   */
  async buildLaunch(
    session: Session,
    workspaceDir: string,
    opts: BuildLaunchOpts = {},
  ): Promise<LaunchCommand> {
    if (opts.remote === true && this.capabilities.remoteSession !== true) {
      // Defensive: shouldn't fire because we set the capability above,
      // but the cross-runtime contract requires runtimes to refuse
      // unsupported flags rather than silently dropping them.
      throw new RuntimeDoesNotSupportRemoteError(this.kind);
    }
    await ensureDirTrusted(workspaceDir, this.copilotConfigPath);
    // Pass the id through the validator so a tampered session.json can't
    // smuggle shell metacharacters into the displayed `--resume=<id>` string.
    const id = safeCopilotId(session.runtimeSessionId);
    return buildCopilotLaunchCommand(session.workdir, id, opts);
  }

  async refresh(
    session: Session,
  ): Promise<{ lastActiveAt: string; preview: string | null; runtimeSessionId: string } | null> {
    const id = safeCopilotId(session.runtimeSessionId);
    if (id === null) {
      // null id: not yet provisioned (legacy data shape) or the persisted id
      // is malformed. Either way there's no copilot state to read.
      return null;
    }
    try {
      const state = await readCopilotSessionState(this.copilotStateDir, id);
      if (state === null) return null;
      return {
        lastActiveAt: state.lastActiveAt,
        preview: state.preview,
        runtimeSessionId: state.runtimeSessionId,
      };
    } catch (err) {
      throw new RuntimeRefreshFailed(this.kind, session.id, err as Error);
    }
  }

  async deleteState(session: Session): Promise<void> {
    const id = safeCopilotId(session.runtimeSessionId);
    if (id === null) return;
    const dir = path.join(this.copilotStateDir, id);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      throw new RuntimeStateDeletionFailed(this.kind, session.id, err as Error);
    }
  }

  /**
   * Spawn copilot non-interactively against `taskDir` to consume `prompt`
   * unattended. Delegates to `dispatchCopilotTask` so the spawn machinery
   * stays isolated and unit-testable. The returned `TaskHandle` carries
   * the runtime session id (so `TaskManager` can persist it for later
   * inspection / debug) and a pre-resolved `sessionDir` Promise pointing
   * at the just-created `<copilotStateDir>/<id>/`.
   */
  async dispatchTask(opts: DispatchCopilotTaskOpts): Promise<TaskHandle> {
    return dispatchCopilotTask(opts, {
      copilotStateDir: this.copilotStateDir,
      globalDir: this.globalDir,
      randomUUID: this.randomUUID,
      ...this.dispatchDeps,
    });
  }

  /**
   * Read + parse + derive — end-to-end. Reads `events.jsonl` from
   * `<copilotStateDir>/<runtimeSessionId>/`, lifts to ActivityItem[],
   * picks the headline result. Returns `null` if the file isn't on
   * disk yet (task hasn't emitted its first event).
   *
   * The runtime owns the path discovery so consumers (server route,
   * dashboard) never see Copilot's internal `events.jsonl` shape or
   * its `~/.copilot/session-state/` layout.
   */
  async taskActivity(opts: TaskActivityOpts): Promise<TaskActivityResult | null> {
    const sessionId = opts.metadata.runtimeSessionId;
    if (typeof sessionId !== "string" || !isCopilotSessionId(sessionId)) {
      return null;
    }
    const eventsPath = path.join(this.copilotStateDir, sessionId, "events.jsonl");
    let raw: string;
    try {
      raw = await readFile(eventsPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw err;
    }
    return {
      activity: parseCopilotActivity(raw),
      result: deriveCopilotResult(raw),
    };
  }
}

/**
 * Return the id if it's a syntactically-valid copilot session id, else null.
 * Centralised so refresh/buildLaunch/deleteState all defend against tampered
 * persisted state in the same way.
 */
function safeCopilotId(id: string | null): string | null {
  if (id === null) return null;
  return isCopilotSessionId(id) ? id : null;
}
