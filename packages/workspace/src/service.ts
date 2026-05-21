import { mkdir, rm } from "node:fs/promises";
import { type Logger, silentLogger } from "@emploke/logger";
import {
  WorkspaceIdConflictError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "./errors.js";
import { workspaceLayout } from "./layout.js";
import type { WorkspaceRepository } from "./repository.js";
import {
  assertValidWorkspaceId,
  assertValidWorkspaceName,
  InputValidationError,
  normalizeWorkspaceDir,
  OpenWorkspaceInput,
  RegisterWorkspaceInput,
  RenameWorkspaceInput,
  UnregisterWorkspaceInput,
} from "./validators.js";

/**
 * Workspace use-case API.
 *
 * Each method: parse input → validate → run async FS work outside the
 * DB transaction → run the DB transaction last. SQLite transactions
 * are synchronous under better-sqlite3, so the FS-then-DB ordering is
 * mandatory: long-running async work inside `db.transaction()` would
 * hold the connection lock for the duration.
 */
export class WorkspaceService {
  constructor(
    private readonly repo: WorkspaceRepository,
    private readonly logger: Logger = silentLogger,
  ) {}

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

      // FS-first: surface mount/permission errors before any registry
      // mutation so a write-protected path doesn't leave an orphan row.
      // Uniqueness check happens at the row insert below (DB UNIQUE
      // constraint on workspace_dir + explicit findById pre-check).
      const byId = await this.repo.findById(input.id);
      if (byId) throw new WorkspaceIdConflictError(input.id);
      const byPath = await this.repo.findByPath(workspaceDir);
      if (byPath) throw new WorkspacePathConflictError(workspaceDir, byPath.id);

      await mkdir(workspaceDir, { recursive: true });
      const layout = workspaceLayout(workspaceDir);
      await Promise.all([
        mkdir(layout.sessions, { recursive: true }),
        mkdir(layout.tasks, { recursive: true }),
      ]);

      const now = new Date().toISOString();
      await this.repo.insert({
        id: input.id,
        name: input.name,
        workspaceDir,
        createdAt: now,
        lastOpenedAt: now,
      });

      this.logger.debug({ command: "register", id: input.id }, "command handled");
      return { id: input.id };
    } catch (err) {
      this.logger.warn({ command: "register", err }, "command failed");
      throw err;
    }
  }

  async open(input: { id: string }): Promise<void> {
    this.logger.debug({ command: "open", input }, "handling command");
    try {
      const parsed = OpenWorkspaceInput.safeParse(input);
      if (!parsed.success) {
        throw new InputValidationError("open", parsed.error.issues);
      }
      assertValidWorkspaceId(input.id);

      const ws = await this.repo.findById(input.id);
      if (!ws) throw new WorkspaceNotRegisteredError(input.id);
      await this.repo.update(input.id, { lastOpenedAt: new Date().toISOString() });
      this.logger.debug({ command: "open", id: input.id }, "command handled");
    } catch (err) {
      this.logger.warn({ command: "open", err }, "command failed");
      throw err;
    }
  }

  async rename(input: { id: string; newName: string }): Promise<void> {
    this.logger.debug({ command: "rename", input }, "handling command");
    try {
      const parsed = RenameWorkspaceInput.safeParse(input);
      if (!parsed.success) {
        throw new InputValidationError("rename", parsed.error.issues);
      }
      assertValidWorkspaceId(input.id);
      assertValidWorkspaceName(input.newName);

      const ws = await this.repo.findById(input.id);
      if (!ws) throw new WorkspaceNotRegisteredError(input.id);
      if (ws.name === input.newName) return;
      await this.repo.update(input.id, { name: input.newName });
      this.logger.debug({ command: "rename", id: input.id }, "command handled");
    } catch (err) {
      this.logger.warn({ command: "rename", err }, "command failed");
      throw err;
    }
  }

  async unregister(input: { id: string; purge?: boolean }): Promise<void> {
    const normalized = { id: input.id, purge: input.purge ?? false };
    this.logger.debug({ command: "unregister", input: normalized }, "handling command");
    try {
      const parsed = UnregisterWorkspaceInput.safeParse(normalized);
      if (!parsed.success) {
        throw new InputValidationError("unregister", parsed.error.issues);
      }
      assertValidWorkspaceId(normalized.id);

      const existing = await this.repo.findById(normalized.id);
      if (!existing) return; // idempotent

      if (normalized.purge) {
        const layout = workspaceLayout(existing.workspaceDir);
        await Promise.all([
          rm(layout.sessions, { recursive: true, force: true }),
          rm(layout.tasks, { recursive: true, force: true }),
        ]);
      }

      await this.repo.delete(normalized.id);
      this.logger.debug({ command: "unregister", id: normalized.id }, "command handled");
    } catch (err) {
      this.logger.warn({ command: "unregister", err }, "command failed");
      throw err;
    }
  }
}
