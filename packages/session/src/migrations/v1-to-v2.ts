import type { Migration } from "@emploke/workspace";

/**
 * Migrate `sessions` from v1 → v2 for issue #120.
 *
 * Adds `agent TEXT NOT NULL` as a first-class column (was previously
 * derived per-call by reading `<sessionsDir>/<id>/AGENTS.md` and
 * parsing the frontmatter — N file reads + N YAML parses on every
 * `list()`, plus a JS-side post-filter for `list({agent})`). Persists
 * the FQN at provision time, frozen for the lifetime of the row
 * (matches `task.agent` semantics; AGENTS.md remains user-editable
 * for runtime-facing content but the session's identity stays the
 * value emploke saw at create time).
 *
 * Migration is split across two phases:
 *
 *   1. **This SQL migration** (`v1To2`): pure DDL — `ALTER TABLE …
 *      ADD COLUMN agent TEXT NOT NULL DEFAULT ''` plus a new
 *      `sessions_agent_idx`. The empty-string default satisfies
 *      `NOT NULL` for existing rows; new rows must provide a
 *      non-empty value (enforced by `Session.fromStored` validation,
 *      not by SQL — keeping the validation in one place mirrors how
 *      `runtime` empty-string is rejected today).
 *
 *   2. **Application-side backfill** (in `SessionManager` startup, NOT
 *      in this file): for each row where `agent = ''`, read
 *      `<sessionsDir>/<id>/AGENTS.md` via the existing
 *      `readAgentName(workdir)` helper and `UPDATE sessions SET
 *      agent = ?`. Rows whose AGENTS.md is missing or unreadable stay
 *      at `''`; lists surface them with an empty `agent` field and a
 *      one-line warning is logged (this matches today's behaviour
 *      where the same condition causes `list()` to silently drop the
 *      row from results).
 *
 * The migration cannot do the AGENTS.md read itself: the coordinator
 * only sees the `DatabaseSync` handle, not `sessionsDir`. Splitting
 * the SQL from the FS-coupled backfill keeps each piece runnable in
 * its natural execution context (migration in the coordinator's
 * transaction; backfill at first-launch under the manager's
 * `sessionsDir`).
 *
 * The coordinator wraps the batch in `BEGIN IMMEDIATE` + `PRAGMA
 * foreign_keys = OFF`, so this migration's SQL must NOT include its
 * own transaction markers.
 */
export const v1To2: Migration = {
  pkg: "session",
  fromVersion: 1,
  toVersion: 2,
  schemaSQL: `
    ALTER TABLE sessions ADD COLUMN agent TEXT NOT NULL DEFAULT '';
    CREATE INDEX sessions_agent_idx ON sessions(agent);
  `,
};
