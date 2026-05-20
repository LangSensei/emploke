import type { DatabaseSync } from "node:sqlite";
import { MigrationCoordinator } from "./coordinator.js";
import type { Migration, MigrationRunResult } from "./types.js";

/**
 * Convenience helper that registers a set of pkg/migration pairs
 * against a fresh {@link MigrationCoordinator} and runs them. The
 * server's startup wiring uses this; tests use it too so they don't
 * have to reproduce the register-then-run boilerplate.
 *
 * Returns the coordinator's result so callers can log
 * `applied.length` / `alreadyAtTarget` at startup.
 *
 * This is the only runner — there used to be a synchronous variant
 * for test fixtures, but every catalog migration as of #122 declares
 * an async backfill hook, so the sync runner became unusable for
 * half the test suite. Issue #133 consolidated on the async runner
 * across the board; test fixtures use `await runPkgMigrations(...)`
 * from `beforeEach(async () => …)`.
 */
export async function runPkgMigrations(
  db: DatabaseSync,
  registrations: readonly { readonly pkg: string; readonly migrations: readonly Migration[] }[],
): Promise<MigrationRunResult> {
  const coordinator = new MigrationCoordinator();
  for (const { pkg, migrations } of registrations) {
    coordinator.register(pkg, migrations);
  }
  return coordinator.run(db);
}
