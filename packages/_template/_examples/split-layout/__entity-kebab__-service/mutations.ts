// EXAMPLE FILE — not built. See docs/pkg-template.md § Splitting big files via facade + sibling subdir.
//
// Write-side concern. Owns id minting, input validation, and any cross-pkg
// coordination a write triggers. Shares ctx with queries.ts / lifecycle.ts;
// never imports them (peer concerns are decoupled — they communicate via ctx,
// not via direct calls).

import { randomBytes } from "node:crypto";
import { withRequestLogging } from "./_helpers.js";
import type { __Entity__, __Entity__ServiceCtx, Create__Entity__Args } from "./types.js";

/**
 * Create a fresh entity. Mints the id and createdAt timestamp inside the
 * service (not the repository) so tests can inject a fake clock via the
 * ctx's `now` seam without touching repository internals.
 */
export async function create__Entity__(
  ctx: __Entity__ServiceCtx,
  args: Create__Entity__Args,
): Promise<__Entity__> {
  return withRequestLogging(ctx, "create", async () => {
    // TODO: replace with your package's id generator (see packages/task/src/validate.ts
    // for the date-prefixed id pattern emploke services typically use).
    const id = randomBytes(8).toString("hex");
    const createdAt = ctx.now().toISOString();
    const row: __Entity__ = { id, name: args.name, createdAt };
    await ctx.repository.insert(row);
    return row;
  });
}

/**
 * Hard delete by id. Throws if the id is unknown so the caller gets a
 * 404-shaped error rather than a silent no-op. Soft-delete (setting a
 * `deletedAt` column) is a different concern — implement it as a separate
 * mutation when the BC needs it.
 */
export async function delete__Entity__(ctx: __Entity__ServiceCtx, id: string): Promise<void> {
  return withRequestLogging(ctx, "delete", async () => {
    const existing = await ctx.repository.findById(id);
    if (existing === undefined) {
      // TODO: replace with your package's `__Entity__NotFoundError` from errors.ts.
      throw new Error(`__Entity__ "${id}" not found`);
    }
    await ctx.repository.delete(id);
  });
}
