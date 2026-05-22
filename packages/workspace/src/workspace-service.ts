import { mkdir, rm } from "node:fs/promises";
import pino, { type Logger } from "pino";
import {
  WorkspaceIdConflictError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "./errors.js";
import { workspaceLayout } from "./layout.js";
import type { Workspace } from "./types.js";
import {
  assertValidWorkspaceId,
  assertValidWorkspaceName,
  InputValidationError,
  normalizeWorkspaceDir,
  RegisterWorkspaceInput,
} from "./validate.js";
import type { WorkspaceRepository } from "./workspace-repository.js";

const silentLogger: Logger = pino({ level: "silent" });

/**
 * Workspace use-case API.
 *
 * Exposes the full workspace surface: write commands (`register`,
 * `open`, `rename`, `unregister`) and read projections (`getById`,
 * `list`, `getLastOpened`, `getLastOpenedId`). All read paths go
 * through the repository to the {@link WorkspaceEntity} layer and
 * the service projects to the wire {@link Workspace} DTO via
 * {@link entityToDto}. Three-layer split per
 * `docs/pkg-template.md` "Repository contract":
 *
 *   Drizzle Row → WorkspaceEntity (repo boundary) → Workspace (wire)
 *
 * The repository hides ORM specifics; the service hides nullability
 * normalisation and any cross-pkg composition (none for workspace,
 * but session adds workdir + runtime metadata at this same layer).
 *
 * Each write method: parse input → validate → run async FS work →
 * write to the DB last. The FS-then-DB ordering is deliberate: FS
 * work is the side-effect we cannot rollback, so doing it before the
 * DB write means a crash mid-register at worst leaves an empty
 * directory (idempotent retry-friendly) rather than a registry row
 * pointing at a directory that doesn't exist.
 *
 * Concurrency: register's pre-flight `findById` / `findByPath` checks
 * are best-effort UX. Two concurrent registers can race past them;
 * the UNIQUE / PRIMARY KEY constraints on the `workspaces` table are
 * the deterministic backstop, and the insert is wrapped to translate
 * SQLite constraint errors back into typed domain errors. We do not
 * wrap each call in a SQLite transaction because better-sqlite3
 * transactions are synchronous — wrapping `mkdir` inside one would
 * hold the writer lock across an IO boundary.
 */
export class WorkspaceService {
  constructor(
    private readonly repo: WorkspaceRepository,
    private readonly logger: Logger = silentLogger,
  ) {}

  // ─── Reads ─────────────────────────────────────────────

  async getById(id: string): Promise<Workspace | null> {
    const entity = await this.repo.findById(id);
    return entity ? { ...entity, lastOpenedAt: entity.lastOpenedAt ?? entity.createdAt } : null;
  }

  async list(): Promise<Workspace[]> {
    // Per README contract: "a single unreadable workspace is silently
    // dropped rather than failing the whole list" — wrap each entity
    // projection so a malformed row (future stricter view, schema
    // skew, NULL-where-not-expected) doesn't blow up the whole call.
    // `getById` keeps fail-loud behaviour because the caller asked for
    // that specific id.
    const entities = await this.repo.findAllByLastOpened();
    const out: Workspace[] = [];
    for (const entity of entities) {
      try {
        out.push({ ...entity, lastOpenedAt: entity.lastOpenedAt ?? entity.createdAt });
      } catch (err) {
        this.logger.warn(
          {
            workspaceId: entity.id,
            err,
          },
          "workspace list: dropping malformed row",
        );
      }
    }
    return out;
  }

  async getLastOpened(): Promise<Workspace | null> {
    const entity = await this.repo.findLastOpened();
    return entity ? { ...entity, lastOpenedAt: entity.lastOpenedAt ?? entity.createdAt } : null;
  }

  async getLastOpenedId(): Promise<string | null> {
    return (await this.repo.findLastOpenedId()) ?? null;
  }

  // ─── Writes ────────────────────────────────────────────

  async register(input: {
    id: string;
    workspaceDir: string;
    name: string;
  }): Promise<{ id: string }> {
    this.logger.debug({ command: "register", input }, "handling command");
    try {
      const parsed = RegisterWorkspaceInput.safeParse(input);
      if (!parsed.success) {
        throw new InputValidationError("register", parsed.error.issues);
      }
      assertValidWorkspaceId(input.id);
      assertValidWorkspaceName(input.name);
      const workspaceDir = normalizeWorkspaceDir(input.workspaceDir);

      const byId = await this.repo.findById(input.id);
      if (byId) throw new WorkspaceIdConflictError(input.id);
      const byPath = await this.repo.findByPath(workspaceDir);
      if (byPath) throw new WorkspacePathConflictError(workspaceDir, byPath.id);

      // FS-then-DB ordering: we mkdir() before the row insert so
      // the workspace skeleton exists by the time any caller observes
      // the new registry row. The trade-off is that an insert failure
      // (constraint race, disk full, etc.) leaves the skeleton on disk;
      // this is benign because subsequent `register()` of the same dir
      // either succeeds (idempotent mkdir + fresh insert) or hits the
      // dup-path check above, and an unused empty skeleton costs ~0
      // bytes and never gets seen by listings (registry is the source
      // of truth).
      await mkdir(workspaceDir, { recursive: true });
      const layout = workspaceLayout(workspaceDir);
      await Promise.all([
        mkdir(layout.sessions, { recursive: true }),
        mkdir(layout.tasks, { recursive: true }),
      ]);

      const now = new Date().toISOString();
      try {
        await this.repo.insert({
          id: input.id,
          name: input.name,
          workspaceDir,
          createdAt: now,
          lastOpenedAt: now,
        });
      } catch (err) {
        // Map UNIQUE / PRIMARY KEY violations to typed domain errors.
        // The pre-checks above are best-effort UX; between the check
        // and the insert two concurrent registers can race, and only
        // the constraint catches it deterministically. better-sqlite3
        // surfaces these as Errors with `code` like
        // `SQLITE_CONSTRAINT_PRIMARYKEY` / `SQLITE_CONSTRAINT_UNIQUE`
        // and a message naming the column.
        const e = err as { code?: string; message?: string };
        if (typeof e.code === "string" && e.code.startsWith("SQLITE_CONSTRAINT")) {
          const msg = e.message ?? "";
          if (msg.includes("workspaces.id") || e.code.endsWith("PRIMARYKEY")) {
            throw new WorkspaceIdConflictError(input.id);
          }
          if (msg.includes("workspaces.workspace_dir")) {
            // We don't know the conflicting id without a re-read; do
            // one targeted lookup so the typed error carries it.
            // Guard against the re-read itself throwing (db closed,
            // lock timeout) — losing the original SQLITE_CONSTRAINT
            // diagnostic to a follow-up error would mask the real
            // cause. On lookup failure, throw the typed error with
            // a sentinel id and re-emit the original constraint
            // error as `cause` so logs can still find it.
            let conflictingId = "<unknown>";
            try {
              const existing = await this.repo.findByPath(workspaceDir);
              if (existing) conflictingId = existing.id;
            } catch {
              // Best-effort lookup; sentinel id stands in.
            }
            throw new WorkspacePathConflictError(workspaceDir, conflictingId);
          }
        }
        throw err;
      }

      this.logger.debug({ command: "register", id: input.id }, "command handled");
      return { id: input.id };
    } catch (err) {
      this.logger.warn({ command: "register", err }, "command failed");
      throw err;
    }
  }

  async open(id: string): Promise<void> {
    this.logger.debug({ command: "open", id }, "handling command");
    try {
      assertValidWorkspaceId(id);
      const ws = await this.repo.findById(id);
      if (!ws) throw new WorkspaceNotRegisteredError(id);
      await this.repo.update(id, { lastOpenedAt: new Date().toISOString() });
      this.logger.debug({ command: "open", id }, "command handled");
    } catch (err) {
      this.logger.warn({ command: "open", err }, "command failed");
      throw err;
    }
  }

  async rename(id: string, opts: { readonly newName: string }): Promise<void> {
    this.logger.debug({ command: "rename", id, opts }, "handling command");
    try {
      assertValidWorkspaceId(id);
      assertValidWorkspaceName(opts.newName);

      const ws = await this.repo.findById(id);
      if (!ws) throw new WorkspaceNotRegisteredError(id);
      if (ws.name === opts.newName) {
        this.logger.debug({ command: "rename", id, reason: "noop" }, "command handled");
        return;
      }
      await this.repo.update(id, { name: opts.newName });
      this.logger.debug({ command: "rename", id }, "command handled");
    } catch (err) {
      this.logger.warn({ command: "rename", err }, "command failed");
      throw err;
    }
  }

  async unregister(id: string, opts: { readonly purge?: boolean } = {}): Promise<void> {
    const purge = opts.purge ?? false;
    this.logger.debug({ command: "unregister", id, purge }, "handling command");
    try {
      assertValidWorkspaceId(id);

      const existing = await this.repo.findById(id);
      if (!existing) return; // idempotent

      if (purge) {
        const layout = workspaceLayout(existing.workspaceDir);
        await Promise.all([
          rm(layout.sessions, { recursive: true, force: true }),
          rm(layout.tasks, { recursive: true, force: true }),
        ]);
      }

      await this.repo.delete(id);
      this.logger.debug({ command: "unregister", id }, "command handled");
    } catch (err) {
      this.logger.warn({ command: "unregister", err }, "command failed");
      throw err;
    }
  }
}
