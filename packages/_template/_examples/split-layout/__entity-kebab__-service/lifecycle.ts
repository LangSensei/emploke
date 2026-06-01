// EXAMPLE FILE — not built. See _examples/split-layout/README.md.
//
// Startup / shutdown / supervisory concerns. Owns the boundary at which the
// service hooks into the host process: log lines on boot, in-memory state
// initialization, graceful drain on shutdown. Lives in its own concern file
// so that queries.ts / mutations.ts stay focused on per-request semantics
// and don't gain process-lifetime responsibilities.

import type { __Entity__ServiceCtx } from "./types.js";

/**
 * Run-once initializer. Call this from `composeXxxModule` after the
 * repository is wired up but before returning the service handle to the
 * composition root, so the first request sees an already-warmed state.
 *
 * The real-world counterpart in `packages/task/src/task-service/mutations.ts`
 * is `recoverOrphaned()` — sweep crashed-before tasks at boot, fold their
 * runtime status to a terminal value. Use this seam for any "must run before
 * first request" work.
 */
export async function initialize__Entity__Service(ctx: __Entity__ServiceCtx): Promise<void> {
  ctx.logger.info("__entity__ service: initializing");
  // TODO: warm caches, replay journal entries, recover orphaned in-flight
  // work, schedule periodic background jobs. Keep cheap — composition is
  // synchronous-ish from the caller's point of view.
}

/**
 * Graceful shutdown. Should drain in-flight work, release subprocess
 * supervisors, and persist any pending state to disk. Idempotent — the
 * composition root may call it more than once during a noisy shutdown.
 */
export async function shutdown__Entity__Service(ctx: __Entity__ServiceCtx): Promise<void> {
  ctx.logger.info("__entity__ service: shutting down");
  // TODO: await pending background work (see packages/task/src/task-service/shutdown.ts
  // for the canonical "drain + kill live subprocesses" implementation). Pure data
  // services can keep this a no-op until they grow background state.
}
