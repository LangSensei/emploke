import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentResolveResult } from "@emploke/catalog";
import {
  RuntimeProvisionFailed,
  RuntimeRefreshFailed,
  RuntimeRegisterWorkspaceFailed,
  RuntimeStateDeletionFailed,
} from "../errors.js";
import type { LaunchCommand, Runtime, Session, TaskHandle } from "../types.js";
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
const DEFAULT_COPILOT_SETTINGS_PATH = path.join(homedir(), ".copilot", "settings.json");

export interface CopilotRuntimeConfig {
  /**
   * Override the directory where copilot stores per-session state. Defaults
   * to `~/.copilot/session-state`. Tests pass a tmp dir; production callers
   * normally leave this unset.
   */
  readonly copilotStateDir?: string;
  /**
   * Override the Copilot CLI settings file we maintain `trustedFolders` in.
   * Defaults to `~/.copilot/settings.json`. Tests pass a tmp path so the
   * real user settings file is never mutated.
   *
   * Used exclusively by `registerWorkspace`; per-session `provision` no
   * longer touches this file.
   */
  readonly copilotSettingsPath?: string;
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
 * Trust: `registerWorkspace(workspaceDir)` is the sole code path that
 * touches `~/.copilot/settings.json`. Server bootstrap calls it once per
 * registered workspace; per-session `provision` no longer interacts with the
 * settings file. This keeps `trustedFolders` from growing unbounded as
 * sessions are created.
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

  private readonly copilotStateDir: string;
  private readonly copilotSettingsPath: string;
  private readonly randomUUID: () => string;
  private readonly dispatchDeps: Partial<DispatchCopilotTaskDeps>;

  constructor(config: CopilotRuntimeConfig = {}) {
    this.copilotStateDir = config.copilotStateDir ?? DEFAULT_COPILOT_STATE_DIR;
    this.copilotSettingsPath = config.copilotSettingsPath ?? DEFAULT_COPILOT_SETTINGS_PATH;
    this.randomUUID = config.randomUUID ?? (() => generateCopilotSessionId());
    this.dispatchDeps = config.dispatchDeps ?? {};
  }

  async provision(
    workdir: string,
    agent: AgentResolveResult,
  ): Promise<{ runtimeSessionId: string }> {
    try {
      await provisionCopilotWorkdir(workdir, agent);
    } catch (err) {
      throw new RuntimeProvisionFailed(this.kind, workdir, err as Error);
    }
    const runtimeSessionId = generateCopilotSessionId(this.randomUUID);
    return { runtimeSessionId };
  }

  /**
   * Idempotent. Records `workspaceDir` in the Copilot CLI's trusted-folders
   * list so any session subsequently provisioned under it can launch
   * without a per-folder trust prompt. If the workspace (or one of its
   * ancestors) is already trusted, this is a no-op write — see
   * `ensureDirTrusted` for the coverage rules and the concurrent-safe
   * read-modify-write protocol.
   */
  async registerWorkspace(workspaceDir: string): Promise<void> {
    try {
      await ensureDirTrusted(workspaceDir, this.copilotSettingsPath);
    } catch (err) {
      throw new RuntimeRegisterWorkspaceFailed(this.kind, workspaceDir, err as Error);
    }
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

  buildLaunch(session: Session): LaunchCommand {
    // Pass the id through the validator so a tampered session.json can't
    // smuggle shell metacharacters into the displayed `--resume=<id>` string.
    const id = safeCopilotId(session.runtimeSessionId);
    return buildCopilotLaunchCommand(session.workdir, id);
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
      randomUUID: this.randomUUID,
      ...this.dispatchDeps,
    });
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
