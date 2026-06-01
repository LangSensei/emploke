// EXAMPLE FILE — not built. See _examples/split-layout/README.md.
//
// Package-private helpers shared across concern files inside this SPLIT.
//
// When to extract here:
//   - Two or more concern files in this subdir need the same helper.
//   - The helper is tightly coupled to the ctx shape (i.e. only makes sense
//     inside this service's split, not as a general utility).
//
// When NOT to extract here:
//   - Used by only one concern → keep it private to that concern's file.
//   - General-purpose utility (e.g. an ISO timestamp helper, a string slugifier)
//     used by multiple packages → promote it to the package's own utility file
//     or to a shared `_shared.ts` at a higher level (see
//     `docs/pkg-template.md § When NOT to use this pattern`).
//
// The leading underscore on this filename mirrors the "package-private utility,
// not a facade-split peer" convention used by top-level `_shared.ts` files in
// `packages/server/src/routes/_shared.ts` and `packages/terminal/src/_shared.ts`.

import type { __Entity__ServiceCtx } from "./types.js";

/**
 * Wrap a per-request handler with structured logging so every concern's
 * methods report uniformly. Used by queries.ts AND mutations.ts — the kind
 * of repetition that justifies extracting a shared helper.
 */
export async function withRequestLogging<T>(
  ctx: __Entity__ServiceCtx,
  op: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = ctx.now().getTime();
  try {
    const result = await fn();
    ctx.logger.debug({ op, durationMs: ctx.now().getTime() - startedAt }, "__entity__ op ok");
    return result;
  } catch (err) {
    ctx.logger.warn(
      { op, err, durationMs: ctx.now().getTime() - startedAt },
      "__entity__ op failed",
    );
    throw err;
  }
}
