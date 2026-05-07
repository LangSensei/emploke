import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Catalog } from "@emploke/catalog";
import { CopilotProvisioner, type Provisioner } from "@emploke/provisioner";
import { indexByCwd, scanCopilotSessions } from "./copilot-state.js";
import {
  AgentNotFoundError,
  CopilotSessionNotFoundError,
  CopilotStateDeletionFailed,
  InvalidCopilotSessionIdError,
  SessionAlreadyExistsError,
  SessionNotFoundError,
} from "./errors.js";
import { assertValidSessionId, generateSessionId } from "./ids.js";
import { buildLaunchCommand, buildResumeCommand, isCopilotSessionId } from "./launch.js";
import { readMarker, writeMarker } from "./marker.js";
import { realNormalizeCwd, safeJoinUnderRoot } from "./paths.js";
import type {
  CopilotSessionInfo,
  CreateSessionOpts,
  DeleteSessionOpts,
  LaunchCommand,
  ListSessionOpts,
  Logger,
  SessionMarker,
  SessionRecord,
  SessionsManagerConfig,
} from "./types.js";

const SILENT_LOGGER: Logger = { warn: () => {} };
const DEFAULT_ROOT = path.join(homedir(), ".emploke", "sessions");
const DEFAULT_COPILOT_STATE_DIR = path.join(homedir(), ".copilot", "session-state");
const MAX_CREATE_RETRIES = 5;
const GITIGNORE_LINE = ".emploke/";

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

    // 3. Provision + marker; cleanup on any failure.
    const createdAt = this.now();
    const catalogDir = getCatalogDir(this.catalog);
    const marker: SessionMarker = {
      version: 1,
      agent: agentName,
      createdAt: createdAt.toISOString(),
      ...(catalogDir !== undefined ? { catalogDir } : {}),
    };
    try {
      await this.provisioner.provision({ resolveResult, targetDir: workdir });
      await ensureGitignoreLine(workdir, GITIGNORE_LINE);
      await writeMarker(workdir, marker);
    } catch (err) {
      await safeRm(workdir, this.logger);
      throw err;
    }

    return {
      id,
      workdir,
      agent: agentName,
      ...(marker.catalogDir !== undefined ? { catalogDir: marker.catalogDir } : {}),
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
      // Skip names that don't look like session ids (defensive — also skips
      // user-created dirs that aren't ours).
      if (!/^\d{8}-\d{6}-[0-9a-f]{8}$/.test(id)) continue;
      // Use safeJoinUnderRoot so workdir is always absolute & validated, even
      // if the caller configured a relative `root`.
      const workdir = safeJoinUnderRoot(this.root, id);
      const marker = await readMarker(workdir);
      if (!marker) continue;
      if (opts.agent !== undefined && marker.agent !== opts.agent) continue;

      const cwdKey = await realNormalizeCwd(workdir);
      const copilotSessions = copilotIndex.get(cwdKey) ?? [];
      const latestCopilotSession: CopilotSessionInfo | null = copilotSessions[0] ?? null;
      records.push({
        id,
        workdir,
        agent: marker.agent,
        ...(marker.catalogDir !== undefined ? { catalogDir: marker.catalogDir } : {}),
        createdAt: new Date(marker.createdAt),
        copilotSessions,
        latestCopilotSession,
      });
    }

    // Newest emploke sessions first — id is timestamp-prefixed so lexical desc
    // is chronological desc.
    records.sort((a, b) => b.id.localeCompare(a.id));
    return records;
  }

  // ─── get ─────────────────────────────────────────────────

  async get(id: string): Promise<SessionRecord | null> {
    assertValidSessionId(id);
    const workdir = safeJoinUnderRoot(this.root, id);
    const marker = await readMarker(workdir);
    if (!marker) return null;

    const copilotEntries = await scanCopilotSessions(this.copilotStateDir, this.logger);
    const copilotIndex = indexByCwd(copilotEntries);
    const cwdKey = await realNormalizeCwd(workdir);
    const copilotSessions = copilotIndex.get(cwdKey) ?? [];
    const latestCopilotSession: CopilotSessionInfo | null = copilotSessions[0] ?? null;

    return {
      id,
      workdir,
      agent: marker.agent,
      ...(marker.catalogDir !== undefined ? { catalogDir: marker.catalogDir } : {}),
      createdAt: new Date(marker.createdAt),
      copilotSessions,
      latestCopilotSession,
    };
  }

  // ─── delete ──────────────────────────────────────────────

  async delete(id: string, opts: DeleteSessionOpts = {}): Promise<void> {
    assertValidSessionId(id);
    const workdir = safeJoinUnderRoot(this.root, id);

    // Confirm the session exists before doing anything destructive.
    const exists = await readMarker(workdir);
    if (!exists) {
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
    const marker = await readMarker(workdir);
    if (!marker) throw new SessionNotFoundError(id);
    return buildLaunchCommand(workdir);
  }

  async getResumeCommand(id: string, copilotSessionId: string): Promise<LaunchCommand> {
    assertValidSessionId(id);
    if (!isCopilotSessionId(copilotSessionId)) {
      throw new InvalidCopilotSessionIdError(copilotSessionId);
    }
    const workdir = safeJoinUnderRoot(this.root, id);
    const marker = await readMarker(workdir);
    if (!marker) throw new SessionNotFoundError(id);
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
 * Append `line` to `<workdir>/.gitignore` if not already present. Creates the
 * file if missing. Newline-normalized: ensures the line is on its own line.
 */
async function ensureGitignoreLine(workdir: string, line: string): Promise<void> {
  const file = path.join(workdir, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    // File doesn't exist — create with just the line.
    await writeFile(file, `${line}\n`, "utf8");
    return;
  }
  // Match line exactly (trim CR for CRLF files).
  const lines = existing.split(/\r?\n/);
  if (lines.some((l) => l === line)) return;
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await writeFile(file, `${existing}${sep}${line}\n`, "utf8");
}

/**
 * Best-effort extraction of the catalog directory for the marker. Catalog
 * doesn't expose a getter, so we read the private field by structural typing.
 * If unavailable, return undefined — the marker field is optional.
 */
function getCatalogDir(catalog: Catalog): string | undefined {
  const c = catalog as unknown as { catalogDir?: unknown };
  return typeof c.catalogDir === "string" ? c.catalogDir : undefined;
}

// Static crypto import — pure ESM, no require() in module-typed packages.
import { randomBytes as cryptoRandomBytes } from "node:crypto";

function defaultRandomBytes(n: number): Buffer {
  return cryptoRandomBytes(n);
}

export { indexByCwd, scanCopilotSessions } from "./copilot-state.js";
export { assertValidSessionId, generateSessionId, SESSION_ID_RE } from "./ids.js";
export { buildLaunchCommand, buildResumeCommand, isCopilotSessionId } from "./launch.js";
export { markerPathFor, readMarker, writeMarker } from "./marker.js";
// Re-export internals used by tests (avoid duplicating logic in test files).
export { normalizeCwd, realNormalizeCwd, safeJoinUnderRoot } from "./paths.js";
