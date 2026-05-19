import type { Migration } from "@emploke/workspace";

/**
 * Migrate `tasks` from v2 → v3 for ADR-001's structured
 * `TaskFailure` / `TaskCancellation` discriminated unions.
 *
 * Purely additive: five new nullable columns. No existing data
 * needs to move; the legacy `failure_error` column is REUSED as the
 * storage column for `TaskFailure.message` (see the repository's
 * `reassembleFailure` for the read-side logic), and the read path
 * synthesises `{ kind: 'internal', message: failure_error }` for
 * rows whose `failure_kind` is NULL (which is every v2 row).
 *
 * Preserved verbatim from the pre-#123 inline `migrateV2ToV3`
 * (commit history: PR #116). The only change is dropping the inline
 * `BEGIN;` / `COMMIT;` — the coordinator now owns the surrounding
 * transaction.
 */
export const v2To3: Migration = {
  pkg: "task",
  fromVersion: 2,
  toVersion: 3,
  schemaSQL: `
    ALTER TABLE tasks ADD COLUMN failure_kind         TEXT;
    ALTER TABLE tasks ADD COLUMN failure_exit_code    INTEGER;
    ALTER TABLE tasks ADD COLUMN failure_signal       TEXT;
    ALTER TABLE tasks ADD COLUMN cancellation_kind    TEXT;
    ALTER TABLE tasks ADD COLUMN cancellation_message TEXT;
  `,
};
