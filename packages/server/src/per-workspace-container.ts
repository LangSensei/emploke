import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AGENT_MIGRATIONS,
  CatalogManager,
  MCP_MIGRATIONS,
  SKILL_MIGRATIONS,
} from "@emploke/catalog";
import { type Logger, silentLogger } from "@emploke/logger";
import type { RuntimeRegistry } from "@emploke/runtime";
import { SESSION_MIGRATIONS, SessionManager, SqliteSessionRepository } from "@emploke/session";
import { SqliteTaskRepository, TASK_MIGRATIONS, TaskManager } from "@emploke/task";
import {
  runPkgMigrations,
  type WorkspaceQueries,
  type WorkspaceView,
  workspaceLayout,
} from "@emploke/workspace";
import type { Container } from "inversify";
import { Container as InversifyContainer } from "inversify";

/**
 * Thrown by `PerWorkspaceContainerCache.reload` when the cached
 * container for the requested workspace still has live task
 * subprocesses being supervised by its `TaskManager`.
 *
 * Reload would `entries.delete(id)` and let the next request lazy-build
 * a fresh container. The fresh `TaskManager`'s `recoverOrphaned` sweep
 * would see the persisted task rows still flipped to `running` (because
 * the OLD manager's exit watcher hasn't fired yet) and race to
 * reclassify them as `failure`, even though the subprocess itself is
 * alive and well. To keep that race off the table we refuse the
 * reload and surface this typed error to the caller (the route maps
 * it to HTTP 409).
 *
 * The user resolves it the same way as any other in-flight conflict:
 * cancel the running tasks (or wait for them to finish), then retry.
 */
export class WorkspaceHasLiveTasksError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly liveCount: number,
  ) {
    super(`workspace has ${liveCount} live task(s); reload would orphan them`);
    this.name = "WorkspaceHasLiveTasksError";
  }
}

/**
 * Per-workspace bundle of long-lived state. The server caches one of
 * these per registered workspace and hands it to route handlers via
 * Hono context.
 *
 * Each container holds:
 *   - a child inversify container (`childContainer = root.createChild()`)
 *     into which the per-workspace `workspace.db` is bound for future
 *     phases (session/task/catalog refactors land per-workspace
 *     handlers and resolve them here). Phase 1's session / task /
 *     catalog still use legacy managers attached as properties
 *     below — the child container is **scaffolding** so Phase 3-5 can
 *     adopt the pattern without re-litigating the wiring.
 *   - the per-workspace `DatabaseSync` connection (one per workspace,
 *     owned by the cache; closed on `invalidate` / `closeAll`).
 *   - the cached `CatalogManager` / `SessionManager` / `TaskManager`
 *     pointed at the per-workspace state.
 *   - the workspace's read view (cached at build time; the cache
 *     handles workspace-row mutations by invalidating the entry).
 */
export interface PerWorkspaceContainer {
  readonly workspace: WorkspaceView;
  readonly childContainer: Container;
  /** Shared per-workspace SQLite handle (one per workspace, owned by the cache). */
  readonly db: DatabaseSync;
  readonly catalog: CatalogManager;
  readonly sessions: SessionManager;
  readonly tasks: TaskManager;
}

/**
 * Lazy, memoised resolver from URL workspace id (UUID) to a
 * `PerWorkspaceContainer`.
 *
 * Lookup flow on a cache miss:
 *   1. Look up the workspace via the injected `WorkspaceQueries`. If
 *      not registered, return null — the route handler will respond 404.
 *   2. Open a per-workspace `DatabaseSync` against
 *      `<workspaceDir>/workspace.db` and run the cross-pkg migration
 *      coordinator. (Tables for session/task/catalog all share this DB.)
 *   3. Create a child inversify container off the root and bind the
 *      per-workspace DB into it. No Phase 1 handler resolves through
 *      this child yet; future phases will.
 *   4. Build the legacy `CatalogManager` / `SessionManager` /
 *      `TaskManager` against the shared per-workspace DB.
 *   5. Cache the bundle keyed by id.
 *
 * Cached by id (URL identifier) — `invalidate(id)` expires a stale
 * cache entry when the workspace mutates (rename, remove).
 *
 * ## Naming history (P1-4 in `.ceo/design/polish-backlog.md`)
 *
 * Was `WorkspaceContext` / `WorkspaceContextCache` until Phase 1 of
 * issue #135 renamed it to avoid collision with the `Workspace`
 * domain aggregate. The new name reflects what this class actually
 * holds post-Phase-1: a per-workspace **inversify child container**
 * plus the long-lived per-workspace state that gets bound into it.
 */
export class PerWorkspaceContainerCache {
  private readonly rootContainer: Container;
  private readonly runtimeRegistry: RuntimeRegistry;
  private readonly queries: WorkspaceQueries;
  private readonly logger: Logger;
  /**
   * Static env overrides forwarded into every per-workspace
   * `TaskManager` so the spawned task subprocesses inherit a
   * self-describing bag (server URL, API key, EMPLOKE_SHARED_DIR).
   * The per-workspace + per-run fields (`EMPLOKE_WORKSPACE`,
   * `EMPLOKE_WORKSPACE_DIR`, `EMPLOKE_WORK_KIND`, `EMPLOKE_WORK_ID`,
   * `EMPLOKE_WORK_DIR`) are added inside `TaskManager.dispatch` /
   * `SessionManager.assembleLaunchEnv` — this field carries only
   * what the server itself contributes.
   */
  private readonly subprocessEnvBase: NodeJS.ProcessEnv;
  private readonly entries = new Map<string, PerWorkspaceContainer>();
  /**
   * Inflight lookups keyed by id, to dedupe concurrent first-request
   * stampedes (catalog opens and orphan-task recovery are both bounded
   * but non-trivial; we don't want N parallel runs for one workspace).
   */
  private readonly inflight = new Map<string, Promise<PerWorkspaceContainer | null>>();

  constructor(deps: {
    rootContainer: Container;
    runtimeRegistry: RuntimeRegistry;
    queries: WorkspaceQueries;
    logger?: Logger;
    subprocessEnvBase?: NodeJS.ProcessEnv;
  }) {
    this.rootContainer = deps.rootContainer;
    this.runtimeRegistry = deps.runtimeRegistry;
    this.queries = deps.queries;
    this.logger = deps.logger ?? silentLogger;
    this.subprocessEnvBase = deps.subprocessEnvBase ?? {};
  }

  /**
   * Resolve a registered workspace by id. Returns null if no workspace
   * with that id exists. Throws on workspace metadata read failures or
   * runtime setup failures (the route handler maps to 5xx).
   */
  async get(id: string): Promise<PerWorkspaceContainer | null> {
    const cached = this.entries.get(id);
    if (cached) return cached;

    const inflight = this.inflight.get(id);
    if (inflight) return inflight;

    const promise = this.load(id).finally(() => {
      this.inflight.delete(id);
    });
    this.inflight.set(id, promise);
    return promise;
  }

  /**
   * Drop the cached container for `id`. Safe to call when no entry
   * exists. Invoked by routes that mutate workspace metadata (rename,
   * remove) so the next request sees a fresh world. Closes the
   * per-workspace SQLite handle and unbinds the child container before
   * dropping the entry.
   */
  invalidate(id: string): void {
    const cached = this.entries.get(id);
    if (cached) {
      try {
        cached.db.close();
      } catch {
        // best-effort
      }
      try {
        // Child container goes with the per-workspace handles it owns.
        // `unbindAll` is the inversify v7 escape hatch for "this scope
        // is done, drop every binding". Required so the same id can be
        // re-bound when the cache reloads.
        cached.childContainer.unbindAll();
      } catch {
        // best-effort: an already-disposed child throws on unbindAll
      }
      this.logger.info({ workspaceId: id }, "per-workspace container invalidated");
    }
    this.entries.delete(id);
  }

  /**
   * Drop the cached container for `id` and eagerly rebuild it. Returns
   * the fresh container, or null if the workspace is no longer
   * registered.
   *
   * Use case: workspace-level state drift the cached managers can't
   * observe themselves. Today that means orphan-task recovery: the
   * cached `TaskManager` only sweeps task rows once at first
   * touch, so reload re-runs that sweep against the on-disk truth.
   *
   * Refuses (`WorkspaceHasLiveTasksError`) when the existing cached
   * container still has live task subprocesses — see the class jsdoc
   * for why eviction-during-live-task is unsafe. The caller is
   * expected to cancel / wait, then retry.
   *
   * The live-count check + `entries.delete` is a microscopic TOCTOU:
   * a dispatch landing between the two would slip through the gate.
   * In practice this is harmless because (a) `liveCount()` includes
   * `dispatchInProgress` so the window is sub-tick (the dispatch's
   * first await happens AFTER the id is in `dispatchInProgress`), and
   * (b) `recoverOrphaned`'s PID-alive probe in the freshly built
   * TaskManager would skip the still-alive row rather than flip it
   * to failure. Worth knowing for any future caller that expects
   * strict ordering.
   */
  async reload(id: string): Promise<PerWorkspaceContainer | null> {
    const cached = this.entries.get(id);
    if (cached) {
      const live = cached.tasks.liveCount();
      if (live > 0) {
        this.logger.warn(
          { workspaceId: id, liveCount: live },
          "workspace reload refused: live tasks would be orphaned",
        );
        throw new WorkspaceHasLiveTasksError(id, live);
      }
      try {
        cached.db.close();
      } catch {
        // best-effort
      }
      try {
        cached.childContainer.unbindAll();
      } catch {
        // best-effort
      }
    }
    this.entries.delete(id);
    const fresh = await this.get(id);
    if (fresh !== null) {
      this.logger.info({ workspaceId: id }, "per-workspace container reloaded");
    }
    return fresh;
  }

  /**
   * Snapshot of every currently-loaded container. Used by the server's
   * graceful-shutdown hook to drain `TaskManager` subprocesses without
   * forcing every consumer of the cache to depend on `@emploke/task`.
   */
  loaded(): PerWorkspaceContainer[] {
    return [...this.entries.values()];
  }

  /**
   * Close every cached per-workspace SQLite handle and unbind every
   * child container. Required at server shutdown (so the OS releases
   * the workspace.db lock cleanly) and at the end of every test that
   * created ephemeral workspaces (Windows refuses to unlink files
   * with open handles, so the test cleanup `rm -rf <scratch>` would
   * fail with EBUSY without this).
   *
   * Drops every cache entry as a side effect — subsequent `get(id)`
   * calls rebuild from scratch.
   */
  closeAll(): void {
    for (const ctx of this.entries.values()) {
      try {
        ctx.db.close();
      } catch {
        // best-effort
      }
      try {
        ctx.childContainer.unbindAll();
      } catch {
        // best-effort
      }
    }
    this.entries.clear();
  }

  private async load(id: string): Promise<PerWorkspaceContainer | null> {
    const workspace = await this.queries.getById(id);
    if (!workspace) return null;

    const layout = workspaceLayout(workspace.workspaceDir);

    // Open the per-workspace SQLite database. One connection serves
    // every entity (catalog, session, task, future workflow). PRAGMAs
    // are set here, once, so individual repositories don't need to
    // think about them. WAL gives concurrent reader safety; foreign_keys
    // is on so cross-table references are enforced. busy_timeout makes
    // any second writer wait up to 5s on the file lock instead of
    // immediately surfacing SQLITE_BUSY.
    const dbPath = path.join(workspace.workspaceDir, "workspace.db");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace.workspaceDir, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");

    // Run the MigrationCoordinator BEFORE constructing any
    // per-workspace repository. Post-issue-#123, repositories no
    // longer create their own tables — the coordinator owns DDL and
    // the repositories' `ensureSchema()` is a version-check
    // assertion.
    const migrationResult = await runPkgMigrations(db, [
      { pkg: "task", migrations: TASK_MIGRATIONS },
      { pkg: "session", migrations: SESSION_MIGRATIONS },
      { pkg: "catalog_agent", migrations: AGENT_MIGRATIONS },
      { pkg: "catalog_skill", migrations: SKILL_MIGRATIONS },
      { pkg: "catalog_mcp", migrations: MCP_MIGRATIONS },
    ]);
    this.logger.info(
      {
        workspaceId: id,
        applied: migrationResult.applied.length,
        alreadyAtTarget: migrationResult.alreadyAtTarget,
        dbPath,
      },
      "workspace.db migrations complete",
    );

    // Per-workspace child container. Phase 1 scaffolding: no handler
    // resolves through it yet because session / task / catalog are
    // still on the legacy manager pattern. Phase 3-5 will land
    // per-workspace handlers and bind them here so they pick up the
    // per-workspace DB via DI instead of via the manager constructor.
    // Documented inline so the pattern is copy-pasteable.
    //
    // Inversify 7 dropped the v6 `parent.createChild()` shorthand —
    // the canonical replacement is `new Container({ parent })` which
    // produces a container that inherits every root-scope binding
    // (Mediator, Clock, WorkspaceRepository, WorkspaceQueries, …) and
    // can layer per-workspace bindings on top.
    //
    // On invalidate/closeAll we `unbindAll()` the child container so
    // the per-workspace state doesn't leak across reloads.
    const childContainer: Container = new InversifyContainer({ parent: this.rootContainer });
    // The per-workspace DB needs a distinct token from `WorkspaceDb`
    // (which points at `global.db` for the workspace registry) —
    // Phase 3 will define it inside the first pkg that consumes it
    // (session refactor).
    void childContainer;

    // Each manager gets the shared connection via constructor injection.
    // Repositories verify their schema_meta row matches the expected
    // version on first construction; they no longer bootstrap tables.
    const catalog = await CatalogManager.open({ db, logger: this.logger });

    const sessions = new SessionManager({
      catalog,
      runtimeRegistry: this.runtimeRegistry,
      sessionsDir: layout.sessions,
      workspaceDir: workspace.workspaceDir,
      workspaceId: id,
      subprocessEnv: this.subprocessEnvBase,
      repository: new SqliteSessionRepository({ db, logger: this.logger }),
      logger: this.logger,
    });
    // v2 (issue #120) one-shot backfill: populate the `agent` column
    // for any rows the v1→v2 SQL migration left at `''`. Awaited
    // before the container is cached so the first `list()` already
    // sees the populated values — no race with concurrent route
    // handlers.
    await sessions.backfillAgentColumn();

    const tasks = new TaskManager({
      catalog,
      runtimeRegistry: this.runtimeRegistry,
      tasksDir: layout.tasks,
      workspaceDir: workspace.workspaceDir,
      workspaceId: id,
      subprocessEnv: this.subprocessEnvBase,
      repository: new SqliteTaskRepository({ db, logger: this.logger }),
      logger: this.logger,
    });
    // Sweep persisted tasks marked `running` from a previous server
    // lifetime and flip them to `failure`. Cheap query, and it
    // eliminates ghost-running rows in the dashboard immediately on
    // first request to this workspace.
    await tasks.recoverOrphaned();

    const ctx: PerWorkspaceContainer = {
      workspace,
      childContainer,
      db,
      catalog,
      sessions,
      tasks,
    };
    this.entries.set(id, ctx);
    this.logger.info(
      {
        workspaceId: id,
        workspaceDir: workspace.workspaceDir,
        dbPath,
      },
      "per-workspace container built (first request)",
    );
    return ctx;
  }
}
