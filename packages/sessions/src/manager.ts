import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Catalog } from "@emploke/catalog";
import { CopilotProvisioner, type Provisioner } from "@emploke/provisioner";
import { readAgentName } from "./agent-file.js";
import { indexByCwd, scanCopilotSessions } from "./copilot-state.js";
import {
  AgentNotFoundError,
  CopilotSessionNotFoundError,
  CopilotStateDeletionFailed,
  InvalidCopilotSessionIdError,
  SessionAlreadyExistsError,
  SessionNotFoundError,
} from "./errors.js";
import { assertValidSessionId, generateSessionId, SESSION_ID_RE } from "./ids.js";
import { buildLaunchCommand, buildResumeCommand, isCopilotSessionId } from "./launch.js";
import { realNormalizeCwd, safeJoinUnderRoot } from "./paths.js";
import type {
  CopilotSessionInfo,
  CreateSessionOpts,
  DeleteSessionOpts,
  LaunchCommand,
  ListSessionOpts,
  Logger,
  SessionRecord,
  SessionsManagerConfig,
} from "./types.js";

const SILENT_LOGGER: Logger = { warn: () => {} };
const DEFAULT_ROOT = path.join(homedir(), ".emploke", "sessions");
const DEFAULT_COPILOT_STATE_DIR = path.join(homedir(), ".copilot", "session-state");
const MAX_CREATE_RETRIES = 5;

/**
 * Per-session workdir registry.
 *
 * - Owns the on-disk layout under `root` (default `~/.emploke/sessions`).
 * - Discovers Copilot sessions from `copilotStateDir` and joins them by cwd.
 * - Does not spawn any subprocess; getLaunchCommand returns the incantation.
 */
export class SessionsManager {
  private readonly catalog: Catalog;
  private readonly provisioner: Provisioner;
  private readonly root: string;
  private readonly copilotStateDir: string;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly randomBytes: (n: number) => Buffer;

  constructor(config: SessionsManagerConfig) {
    this.catalog = config.catalog;
    this.provisioner = config.provisioner ?? new CopilotProvisioner();
    this.root = config.root ?? DEFAULT_ROOT;
    this.copilotStateDir = config.copilotStateDir ?? DEFAULT_COPILOT_STATE_DIR;
    this.logger = config.logger ?? SILENT_LOGGER;
    this.now = config.now ?? (() => new Date());
    // randomBytes is read lazily from ids.ts default if undefined.
    this.randomBytes = config.randomBytes ?? defaultRandomBytes;
  }

  // ─── create ──────────────────────────────────────────────

  async create(opts: CreateSessionOpts): Promise<SessionRecord> {
    const agentName = opts.agent;
    if (typeof agentName !== "string" || agentName.length === 0) {
      throw new AgentNotFoundError(String(agentName));
    }

    // 1. Resolve agent up-front. Bare-Error throws from the resolver are
    //    rewrapped as AgentNotFoundError — distinguishable to callers.
    let resolveResult: ReturnType<Catalog["resolveAgent"]>;
    try {
      resolveResult = this.catalog.resolveAgent(agentName);
    } catch (err) {
      throw new AgentNotFoundError(agentName, err as Error);
    }

    // 2. Reserve a workdir via exclusive mkdir, retrying on EEXIST.
    await mkdir(this.root, { recursive: true });
    let id: string | null = null;
    let workdir: string | null = null;
    for (let attempt = 0; attempt < MAX_CREATE_RETRIES; attempt++) {
      const candidateId = generateSessionId(this.now, this.randomBytes);
      const candidateDir = safeJoinUnderRoot(this.root, candidateId);
      try {
        await mkdir(candidateDir, { recursive: false });
        id = candidateId;
        workdir = candidateDir;
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") continue;
        throw err;
      }
    }
    if (id === null || workdir === null) {
      // All retries hit EEXIST — return the last id we tried as the conflict
      // marker (best-effort; the caller can retry the whole create).
      throw new SessionAlreadyExistsError(generateSessionId(this.now, this.randomBytes));
    }

    // 3. Provision; cleanup on any failure. The provisioner writes AGENTS.md
    //    (with frontmatter), .copilot/, etc. — there's no separate marker.
    try {
      await this.provisioner.provision({ resolveResult, targetDir: workdir });
    } catch (err) {
      await safeRm(workdir, this.logger);
      throw err;
    }

    // createdAt: read the workdir's birthtime (set when mkdir ran above).
    const createdAt = await readCreatedAt(workdir);

    return {
      id,
      workdir,
      agent: agentName,
      createdAt,
      copilotSessions: [],
      latestCopilotSession: null,
    };
  }

  // ─── list ────────────────────────────────────────────────

  async list(opts: ListSessionOpts = {}): Promise<SessionRecord[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }

    // Build copilot cwd -> sessions map ONCE per call.
    const copilotEntries = await scanCopilotSessions(this.copilotStateDir, this.logger);
    const copilotIndex = indexByCwd(copilotEntries);

    const records: SessionRecord[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const id = e.name;
      // Skip names that don't look like session ids.
      if (!SESSION_ID_RE.test(id)) continue;
      // Use safeJoinUnderRoot so workdir is always absolute & validated, even
      // if the caller configured a relative `root`.
      const workdir = safeJoinUnderRoot(this.root, id);
      const agent = await readAgentName(workdir);
      if (agent === null) {
        // Half-baked dir (provisioner failed mid-way and cleanup also failed)
        // or a foreign dir that happens to match the id pattern. Skip + warn.
        this.logger.warn("sessions: skipping dir without readable AGENTS.md", {
          sessionId: id,
        });
        continue;
      }
      if (opts.agent !== undefined && agent !== opts.agent) continue;

      const createdAt = await readCreatedAt(workdir);
      const cwdKey = await realNormalizeCwd(workdir);
      const copilotSessions = copilotIndex.get(cwdKey) ?? [];
      const latestCopilotSession: CopilotSessionInfo | null = copilotSessions[0] ?? null;
      records.push({
        id,
        workdir,
        agent,
        createdAt,
        copilotSessions,
        latestCopilotSession,
      });
    }

    // Newest first by createdAt. The id no longer encodes within-day order, so
    // we cannot rely on lexical sort; fall back to id desc as a tiebreaker.
    records.sort((a, b) => {
      const d = b.createdAt.getTime() - a.createdAt.getTime();
      return d !== 0 ? d : b.id.localeCompare(a.id);
    });
    return records;
  }

  // ─── get ─────────────────────────────────────────────────

  async get(id: string): Promise<SessionRecord | null> {
    assertValidSessionId(id);
    const workdir = safeJoinUnderRoot(this.root, id);
    const agent = await readAgentName(workdir);
    if (agent === null) return null;

    const copilotEntries = await scanCopilotSessions(this.copilotStateDir, this.logger);
    const copilotIndex = indexByCwd(copilotEntries);
    const cwdKey = await realNormalizeCwd(workdir);
    const copilotSessions = copilotIndex.get(cwdKey) ?? [];
    const latestCopilotSession: CopilotSessionInfo | null = copilotSessions[0] ?? null;
    const createdAt = await readCreatedAt(workdir);

    return {
      id,
      workdir,
      agent,
      createdAt,
      copilotSessions,
      latestCopilotSession,
    };
  }

  // ─── delete ──────────────────────────────────────────────

  async delete(id: string, opts: DeleteSessionOpts = {}): Promise<void> {
    assertValidSessionId(id);
    const workdir = safeJoinUnderRoot(this.root, id);

    // Confirm the session exists before doing anything destructive.
    const agent = await readAgentName(workdir);
    if (agent === null) {
      throw new SessionNotFoundError(id);
    }

    // Compute cwdKey BEFORE rm-ing the workdir (realpath needs the path to
    // exist). Used by both the primary cleanup and the post-rm sweep.
    const cwdKey = opts.deleteCopilotState ? await realNormalizeCwd(workdir) : null;

    if (opts.deleteCopilotState && cwdKey !== null) {
      const copilotEntries = await scanCopilotSessions(this.copilotStateDir, this.logger);
      const matches = copilotEntries.filter((e) => e.cwdKey === cwdKey);
      const failures: { copilotSessionId: string; reason: string }[] = [];
      for (const m of matches) {
        const dir = path.join(this.copilotStateDir, m.info.sessionId);
        try {
          await rm(dir, { recursive: true, force: true });
        } catch (err) {
          failures.push({
            copilotSessionId: m.info.sessionId,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (failures.length > 0) {
        // Leave the workdir intact so the user can retry / inspect.
        throw new CopilotStateDeletionFailed(id, failures);
      }
    }

    await rm(workdir, { recursive: true, force: true });

    // Post-rm sweep: catch copilot sessions that may have been created in
    // the workdir during the delete window. Best-effort — workdir is gone,
    // so we log warnings instead of throwing.
    if (opts.deleteCopilotState && cwdKey !== null) {
      const stragglers = (await scanCopilotSessions(this.copilotStateDir, this.logger)).filter(
        (e) => e.cwdKey === cwdKey,
      );
      for (const s of stragglers) {
        const dir = path.join(this.copilotStateDir, s.info.sessionId);
        try {
          await rm(dir, { recursive: true, force: true });
        } catch (err) {
          this.logger.warn("sessions: failed to clean up straggler copilot state", {
            sessionId: id,
            copilotSessionId: s.info.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // ─── launch / resume ─────────────────────────────────────

  async getLaunchCommand(id: string): Promise<LaunchCommand> {
    assertValidSessionId(id);
    const workdir = safeJoinUnderRoot(this.root, id);
    const agent = await readAgentName(workdir);
    if (agent === null) throw new SessionNotFoundError(id);
    return buildLaunchCommand(workdir);
  }

  async getResumeCommand(id: string, copilotSessionId: string): Promise<LaunchCommand> {
    assertValidSessionId(id);
    if (!isCopilotSessionId(copilotSessionId)) {
      throw new InvalidCopilotSessionIdError(copilotSessionId);
    }
    const workdir = safeJoinUnderRoot(this.root, id);
    const agent = await readAgentName(workdir);
    if (agent === null) throw new SessionNotFoundError(id);
    // Verify the Copilot session actually belongs to this workdir. Without
    // this check, /api/sessions/:id/resume-command/:sid would happily return
    // a command for any UUID-shaped string.
    const copilotEntries = await scanCopilotSessions(this.copilotStateDir, this.logger);
    const cwdKey = await realNormalizeCwd(workdir);
    const owned = copilotEntries.some(
      (e) => e.cwdKey === cwdKey && e.info.sessionId === copilotSessionId,
    );
    if (!owned) {
      throw new CopilotSessionNotFoundError(id, copilotSessionId);
    }
    return buildResumeCommand(workdir, copilotSessionId);
  }
}

// ─── internals ────────────────────────────────────────────

/** Best-effort recursive remove. Logs (does not throw) on failure. */
async function safeRm(p: string, logger: Logger): Promise<void> {
  try {
    await rm(p, { recursive: true, force: true });
  } catch (err) {
    logger.warn("sessions: failed to remove workdir during cleanup", {
      path: p,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Read the workdir's creation timestamp. Prefers `birthtime` (set by mkdir on
 * most modern filesystems); falls back to `mtime` when birthtime is absent or
 * zero (older Linux ext4). Never throws — callers tolerate epoch-zero on the
 * pathological case where neither is available.
 */
async function readCreatedAt(workdir: string): Promise<Date> {
  try {
    const st = await stat(workdir);
    const ms = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    return new Date(ms);
  } catch {
    return new Date(0);
  }
}

// Static crypto import — pure ESM, no require() in module-typed packages.

function defaultRandomBytes(n: number): Buffer {
  return cryptoRandomBytes(n);
}

export { readAgentName } from "./agent-file.js";
export { indexByCwd, scanCopilotSessions } from "./copilot-state.js";
export { assertValidSessionId, generateSessionId, SESSION_ID_RE } from "./ids.js";
export { buildLaunchCommand, buildResumeCommand, isCopilotSessionId } from "./launch.js";
// Re-export internals used by tests (avoid duplicating logic in test files).
export { normalizeCwd, realNormalizeCwd, safeJoinUnderRoot } from "./paths.js";
