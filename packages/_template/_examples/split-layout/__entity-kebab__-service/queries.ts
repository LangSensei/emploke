// EXAMPLE FILE — not built. See docs/pkg-template.md § Splitting big files via facade + sibling subdir.
//
// Read-side concern. Pure data fetches; never mutates state. Each exported
// function takes `ctx` as its first argument (rule #7 from docs/pkg-template.md
// § Hard rules) and is imported individually by the facade (no barrel re-export,
// per rule #2). Filename is the bare role name `queries.ts` (rule #4 — the parent
// subdir `__entity-kebab__-service/` already supplies the entity context).

import { withRequestLogging } from "./_helpers.js";
import type { __Entity__, __Entity__ServiceCtx, List__Entity__Opts } from "./types.js";

/**
 * List entities, newest first, with optional filtering pushed down to the
 * repository. Corrupted rows are silently dropped + warn-logged at the
 * repository layer; this function reports a count, not a per-row decision.
 */
export async function list__Entity__(
  ctx: __Entity__ServiceCtx,
  opts: List__Entity__Opts = {},
): Promise<__Entity__[]> {
  return withRequestLogging(ctx, "list", async () => {
    const rows = await ctx.repository.list(opts);
    // ISO 8601 createdAt → lexicographic sort, newest first. Id is the
    // deterministic tiebreaker for entries created in the same millisecond.
    rows.sort((a, b) => {
      const d = b.createdAt.localeCompare(a.createdAt);
      return d !== 0 ? d : b.id.localeCompare(a.id);
    });
    return rows;
  });
}

/**
 * Fetch a single entity by id. Returns `null` (not `undefined`) on miss to
 * keep wire-shape compatibility with JSON serialisation — `undefined` would
 * disappear from the response body.
 */
export async function get__Entity__(
  ctx: __Entity__ServiceCtx,
  id: string,
): Promise<__Entity__ | null> {
  return withRequestLogging(ctx, "get", async () => {
    const found = await ctx.repository.findById(id);
    return found ?? null;
  });
}
