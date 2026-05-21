import { mkdir, rm } from "node:fs/promises";
import { type Logger, silentLogger } from "@emploke/logger";
import type { EntityManager } from "@mikro-orm/core";
import { Workspace } from "./entity.js";
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
 * One method per use case (register / open / rename / unregister).
 * Each method:
 *   1. Validates input (Zod shape + value rules).
 *   2. Opens a `em.transactional` scope.
 *   3. Performs the cross-aggregate pre-check (uniqueness, existence).
 *   4. Mutates the entity / fs.
 *   5. Returns the wire-shape result.
 *
 * Logging is at debug level on entry / exit and warn on throw. The
 * service does NOT swallow errors — typed `WorkspaceError` subclasses
 * propagate to callers (the server's route layer maps them to HTTP
 * statuses).
 */
export class WorkspaceService {
  constructor(
    private readonly repo: WorkspaceRepository,
    private readonly em: EntityManager,
    private readonly logger: Logger = silentLogger,
  ) {}

  /**
   * Register a brand-new workspace.
   *
   * Creates the workspaceDir + standard subdirs on disk BEFORE
   * persisting, so a write-protected path surfaces as an error before
   * any registry row exists.
   */
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

      const result = await this.em.transactional(async () => {
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

        const ws = new Workspace();
        ws.id = input.id;
        ws.name = input.name;
        ws.workspaceDir = workspaceDir;
        const now = new Date().toISOString();
        ws.createdAt = now;
        ws.lastOpenedAt = now;
        this.repo.add(ws);
        return { id: ws.id };
      });

      this.logger.debug({ command: "register", id: result.id }, "command handled");
      return result;
    } catch (err) {
      this.logger.warn({ command: "register", err }, "command failed");
      throw err;
    }
  }

  /** Promote `id` to most-recently-opened. */
  async open(input: { id: string }): Promise<void> {
    this.logger.debug({ command: "open", input }, "handling command");
    try {
      const parsed = OpenWorkspaceInput.safeParse(input);
      if (!parsed.success) {
        throw new InputValidationError("open", parsed.error.issues);
      }
      assertValidWorkspaceId(input.id);

      await this.em.transactional(async () => {
        const ws = await this.repo.findById(input.id);
        if (!ws) throw new WorkspaceNotRegisteredError(input.id);
        ws.lastOpenedAt = new Date().toISOString();
      });
      this.logger.debug({ command: "open", id: input.id }, "command handled");
    } catch (err) {
      this.logger.warn({ command: "open", err }, "command failed");
      throw err;
    }
  }

  /** Change the display name. No-op when the new name equals the current one. */
  async rename(input: { id: string; newName: string }): Promise<void> {
    this.logger.debug({ command: "rename", input }, "handling command");
    try {
      const parsed = RenameWorkspaceInput.safeParse(input);
      if (!parsed.success) {
        throw new InputValidationError("rename", parsed.error.issues);
      }
      assertValidWorkspaceId(input.id);
      assertValidWorkspaceName(input.newName);

      await this.em.transactional(async () => {
        const ws = await this.repo.findById(input.id);
        if (!ws) throw new WorkspaceNotRegisteredError(input.id);
        if (ws.name === input.newName) return; // no-op, leave UoW clean
        ws.name = input.newName;
      });
      this.logger.debug({ command: "rename", id: input.id }, "command handled");
    } catch (err) {
      this.logger.warn({ command: "rename", err }, "command failed");
      throw err;
    }
  }

  /**
   * Unregister `id`. When `purge=true`, also rm-rf the emploke-owned
   * subdirs (`sessions/`, `tasks/`); the `workspaceDir` itself is
   * never removed (user-owned). Idempotent: unregistering a missing
   * id is a no-op.
   *
   * Purge happens BEFORE the DELETE so the path-conflict guard stays
   * active throughout (preventing a concurrent register from racing
   * with the rm).
   */
  async unregister(input: { id: string; purge?: boolean }): Promise<void> {
    const normalized = { id: input.id, purge: input.purge ?? false };
    this.logger.debug({ command: "unregister", input: normalized }, "handling command");
    try {
      const parsed = UnregisterWorkspaceInput.safeParse(normalized);
      if (!parsed.success) {
        throw new InputValidationError("unregister", parsed.error.issues);
      }
      assertValidWorkspaceId(normalized.id);

      await this.em.transactional(async () => {
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
      });
      this.logger.debug({ command: "unregister", id: normalized.id }, "command handled");
    } catch (err) {
      this.logger.warn({ command: "unregister", err }, "command failed");
      throw err;
    }
  }
}
