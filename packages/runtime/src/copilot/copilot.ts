import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentResolveResult } from "@emploke/catalog";
import {
  RuntimeProvisionFailed,
  RuntimeRefreshFailed,
  RuntimeStateDeletionFailed,
} from "../errors.js";
import type { LaunchCommand, Runtime, Session } from "../types.js";
import { generateCopilotSessionId, isCopilotSessionId } from "./ids.js";
import { buildCopilotLaunchCommand } from "./launch.js";
import { provisionCopilotWorkdir } from "./provision.js";
import { readCopilotSessionState } from "./state.js";

const DEFAULT_COPILOT_STATE_DIR = path.join(homedir(), ".copilot", "session-state");

export interface CopilotRuntimeConfig {
  /**
   * Override the directory where copilot stores per-session state. Defaults
   * to `~/.copilot/session-state`. Tests pass a tmp dir; production callers
   * normally leave this unset.
   */
  readonly copilotStateDir?: string;
  /**
   * Test seam for id generation. Defaults to `crypto.randomUUID`.
   */
  readonly randomUUID?: () => string;
}

/**
 * The Copilot adapter. Pre-allocates a UUID at provision time and threads it
 * through `--resume=<id>` on every launch, so first launch creates the session
 * and subsequent launches resume it. This eliminates the cwd-join logic the
 * old implementation needed (where copilot minted ids and we had to scan all
 * sessions and match by cwd).
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
  private readonly randomUUID: () => string;

  constructor(config: CopilotRuntimeConfig = {}) {
    this.copilotStateDir = config.copilotStateDir ?? DEFAULT_COPILOT_STATE_DIR;
    this.randomUUID = config.randomUUID ?? (() => generateCopilotSessionId());
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
