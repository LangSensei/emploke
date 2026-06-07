/**
 * `composeWorkflowModule` is the production composition entrypoint
 * for `@emploke/workflow`: open the DB, run migrations, wire the
 * repository + service + engine with the caller-supplied per-kind
 * runners.
 *
 * Production callers pass `dbFile` (the pkg opens its own
 * better-sqlite3 connection in WAL mode and runs pending migrations);
 * tests pass an existing `db` from `openTestWorkflowDb()`.
 *
 * Runners are injected at compose time via the `runners` field. The
 * `WorkflowRunners` type is `{ coordinator, worker }`; both fields
 * are non-optional so a missing runner is a TypeScript compile error
 * rather than a runtime throw. To add a new kind, extend
 * `NodeKind` and add a matching field on `WorkflowRunners` — the
 * substrate's exhaustive `switch (kind)` branches will fail to
 * compile until every new kind has a runner.
 *
 * # Engine + two-phase init
 *
 * The {@link WorkflowEngine} is event-driven and shares no state
 * with the substrate. It needs the service to call `dispatchAtomic`
 * + `markNodeTerminal`; the service needs the engine to call
 * `triggerWorkflowTick`. The cycle is resolved by constructing the
 * service with no engine, constructing the engine with the service,
 * then calling `service.setEngine(engine)`. After-tx nudges are
 * no-ops until the setter runs, so the construction order is safe.
 *
 * # `trustedCallerForTesting` (TEST ONLY)
 *
 * Per spec #325 D7 (Option A): when `true`, the substrate's caller-
 * coord auth gate on `addNode` / `addEdge` / `addSubgraph` is
 * bypassed (structural rules — cycle check, parent-readiness, kind-
 * aware rules — still fire). A `warn` log fires once at boot when
 * the flag is `true`. Production paths NEVER set this flag; it is
 * not exposed on `@emploke/api`'s public surface and exists only so
 * tests can populate workflow graphs without standing up a coord
 * runner.
 */

import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import { WorkflowEngine } from "./_engine.js";
import { applyWorkflowMigrations } from "./migrations.js";
import * as schema from "./schema.js";
import type { WorkflowRunners } from "./types.js";
import { WorkflowRepository } from "./workflow-repository.js";
import { WorkflowService } from "./workflow-service.js";

type Db = BetterSQLite3Database<typeof schema>;

export type WorkflowModuleOptions = (
  | { readonly db: Db; readonly dbFile?: never }
  | { readonly dbFile: string; readonly db?: never }
) & {
  readonly workspaceDir: string;
  readonly runners: WorkflowRunners;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
  /**
   * TESTING ONLY — bypasses the caller-coord auth gate on
   * `addNode` / `addEdge` / `addSubgraph` so tests can populate
   * workflow graphs without standing up a coord runner. Structural
   * rules (cycle check, parent-readiness, kind-aware rules) still
   * fire. Logs a `warn` at boot when `true`. Default `false`.
   *
   * Per spec #325 D7 (Option A). NOT exposed on `@emploke/api` —
   * the api-pkg public-API guard test asserts this absence.
   */
  readonly trustedCallerForTesting?: boolean;
};

export interface WorkflowModule {
  readonly service: WorkflowService;
  readonly engine: WorkflowEngine;
  close(): Promise<void>;
}

export async function composeWorkflowModule(opts: WorkflowModuleOptions): Promise<WorkflowModule> {
  let sqlite: BetterSqliteDatabase | null = null;
  let db: Db;
  if ("db" in opts && opts.db !== undefined) {
    db = opts.db;
  } else {
    sqlite = new Database(opts.dbFile as string);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("busy_timeout = 5000");
    db = drizzle(sqlite, { schema });
    try {
      applyWorkflowMigrations(db);
    } catch (err) {
      sqlite.close();
      throw err;
    }
  }
  const repo = new WorkflowRepository({ db });
  const service = new WorkflowService({
    repo,
    db,
    workspaceDir: opts.workspaceDir,
    runners: opts.runners,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.randomUUID !== undefined ? { randomUUID: opts.randomUUID } : {}),
    ...(opts.trustedCallerForTesting === true ? { trustedCallerForTesting: true } : {}),
  });
  const engine = new WorkflowEngine({
    service,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  service.setEngine(engine);

  if (opts.trustedCallerForTesting === true) {
    (opts.logger ?? undefined)?.warn?.(
      "composeWorkflowModule: trustedCallerForTesting=true is active — caller-coord auth gate bypassed on addNode/addEdge/addSubgraph. This flag is TEST ONLY; production code paths must never set it.",
    );
  }

  engine.start();

  return {
    service,
    engine,
    async close() {
      await engine.stop();
      sqlite?.close();
    },
  };
}
