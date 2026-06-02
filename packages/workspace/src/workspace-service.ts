import { mkdir, rm } from "node:fs/promises";
import pino, { type Logger } from "pino";
import {
  WorkspaceError,
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
 * through the repository (which returns the internal `WorkspaceEntity`
 * shape, structurally identical to the Drizzle row today) and are
 * projected inline to the wire `Workspace` DTO by coalescing the
 * nullable `lastOpenedAt` to `createdAt` so consumers never see
 * `null`. The same projection is repeated in each read method; if a
 * future column makes it non-trivial, extract a private `entityToDto`
 * helper at that point.
 *
 * Three-layer split:
 *
 *   Drizzle Row → WorkspaceEntity (repo boundary) → Workspace (wire)
 *
 * The repository hides ORM specifics; the service hides nullability
 * normalisation and any cross-pkg composition (none for workspace,
 * but session adds workdir + runtime metadata at this same layer).
 *
 * Write methods that touch the filesystem (`register`;
 * `unregister({ purge: true })`) do FS work BEFORE the DB write.
 * The FS-then-DB ordering is deliberate: FS work is the side-effect
 * we cannot rollback, so doing it before the DB write means a crash
 * mid-register at worst leaves an empty directory (idempotent
 * retry-friendly) rather than a registry row pointing at a directory
 * that doesn't exist. The pure-DB writes (`open`, `rename`,
 * `unregister({ purge: false })`) skip the FS step entirely.
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

  // Triaged write-path failure log. Typed user-input rejections
  // (`WorkspaceError` subclasses, `InputValidationError`) are 4xx-class
  // and emitted at `debug` — they're routine signal about malformed
  // client input, not actionable noise for ops. Anything else is
  // unexpected and goes through at `warn`.
  private logCommandFailure(command: string, err: unknown): void {
    if (err instanceof WorkspaceError || err instanceof InputValidationError) {
      this.logger.debug({ command, err }, "command rejected");
    } else {
      this.logger.warn({ command, err }, "command failed");
    }
  }

  // ─── Reads ─────────────────────────────────────────────

  async getById(id: string): Promise<Workspace | null> {
    const entity = await this.repo.findById(id);
    return entity ? { ...entity, lastOpenedAt: entity.lastOpenedAt ?? entity.createdAt } : null;
  }

  async list(): Promise<Workspace[]> {
    const entities = await this.repo.findAllByLastOpened();
    return entities.map((entity) => ({
      ...entity,
      lastOpenedAt: entity.lastOpenedAt ?? entity.createdAt,
    }));
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
            // one targeted lookup so the typed error carries it. If
            // the re-read itself throws (db closed, lock timeout),
            // fall back to a sentinel id so the typed error still
            // surfaces — losing the lookup is preferable to masking
            // the original constraint violation behind a follow-up
            // error.
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
      this.logCommandFailure("register", err);
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
      this.logCommandFailure("open", err);
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
      this.logCommandFailure("rename", err);
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
      this.logCommandFailure("unregister", err);
      throw err;
    }
  }
}
