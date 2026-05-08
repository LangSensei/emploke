import type { Catalog } from "@emploke/catalog";
import type { Provisioner } from "@emploke/provisioner";

/** Optional logger surface. Default implementation is silent. */
export interface Logger {
  warn(message: string, meta?: object): void;
}

/** Configuration for SessionsManager. All fields are optional except `catalog`. */
export interface SessionsManagerConfig {
  /** Catalog used to resolve agents at create() time. */
  readonly catalog: Catalog;
  /** Provisioner used to bake agents into the workdir. Defaults to CopilotProvisioner. */
  readonly provisioner?: Provisioner;
  /** Root directory for session workdirs. Defaults to ~/.emploke/sessions. */
  readonly root?: string;
  /** Path to Copilot's session state dir. Defaults to ~/.copilot/session-state. */
  readonly copilotStateDir?: string;
  /** Optional logger. Defaults to silent. */
  readonly logger?: Logger;
  /** Test seam: clock for ID generation. Defaults to () => new Date(). */
  readonly now?: () => Date;
  /** Test seam: random byte source for ID generation. Defaults to crypto.randomBytes. */
  readonly randomBytes?: (n: number) => Buffer;
}

/** A session record returned by list/get/create. */
export interface SessionRecord {
  /** Canonical id; equals the workdir directory name. */
  readonly id: string;
  /** Absolute workdir path, normalized. */
  readonly workdir: string;
  /** Agent name, read from AGENTS.md frontmatter. */
  readonly agent: string;
  /** Workdir creation time (fs stat birthtime, falls back to mtime). */
  readonly createdAt: Date;
  /** Discovered Copilot sessions whose cwd matches the workdir, sorted desc by updatedAt. */
  readonly copilotSessions: readonly CopilotSessionInfo[];
  /** First entry of copilotSessions, or null if none. */
  readonly latestCopilotSession: CopilotSessionInfo | null;
}

/** Best-effort summary of a Copilot session discovered for a workdir. */
export interface CopilotSessionInfo {
  readonly sessionId: string;
  readonly name?: string;
  readonly summary?: string;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

/** Output of getLaunchCommand / getResumeCommand. */
export interface LaunchCommand {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Human-readable single-line form for display / clipboard. */
  readonly display: string;
}

/** Options for SessionsManager.create. */
export interface CreateSessionOpts {
  readonly agent: string;
}

/** Options for SessionsManager.list. */
export interface ListSessionOpts {
  /** Filter to sessions whose AGENTS.md frontmatter name matches this exact value. */
  readonly agent?: string;
}

/** Options for SessionsManager.delete. */
export interface DeleteSessionOpts {
  /**
   * If true, also remove `~/.copilot/session-state/<sid>/` for every Copilot
   * session whose cwd matches the workdir. Computed *before* removing the
   * workdir; if any rm fails, throws CopilotStateDeletionFailed and leaves
   * the workdir intact.
   */
  readonly deleteCopilotState?: boolean;
}
