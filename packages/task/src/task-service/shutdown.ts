import type { TaskServiceCtx } from "../task-service.js";

/**
 * Kill every live subprocess, await their exit + post-exit persistence,
 * and stop accepting new dispatches. Idempotent — calling twice is a
 * no-op the second time.
 */
export async function shutdownService(ctx: TaskServiceCtx): Promise<void> {
  if (ctx.shuttingDown) {
    // Wait for the in-flight shutdown's drain to complete by awaiting
    // current settled promises. New dispatches are already blocked.
    await Promise.allSettled([...ctx.live.values()].map((l) => l.settled));
    return;
  }
  ctx.shuttingDown = true;

  const snapshot = [...ctx.live.values()];
  for (const l of snapshot) {
    // Mark the task as killed-by-shutdown before invoking kill(), so
    // the exit watcher's decideTerminal() call records `failure: {
    // kind:'shutdown' }` rather than reading the natural exit reason.
    // Per-task scope (rather than a global flag) means another task
    // that self-exits cleanly mid-shutdown is still classified as
    // `success` — the kill flag only flips for tasks we actually
    // killed.
    l.killReason = "shutdown";
    try {
      l.handle.kill();
    } catch {
      // Already dead — let the exit watcher run its course.
    }
  }
  // Wait for every exit watcher to finish persisting its terminal
  // status. The watcher reads `liveEntry.killReason` AT exit time
  // to decide between `failure: shutdown` / `cancelled` / natural.
  await Promise.allSettled(snapshot.map((l) => l.settled));
}

/**
 * Test-only seam: await all in-flight background purges scheduled by
 * `delete({ purge: true })`. Awaits the tail of `ctx.purgeQueue`,
 * which serialises every scheduled purge.
 */
export async function drainPendingPurges(ctx: TaskServiceCtx): Promise<void> {
  await ctx.purgeQueue;
}
