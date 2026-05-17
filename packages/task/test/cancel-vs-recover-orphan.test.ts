/**
 * R-10 / ADR-001 §3.8 #9 — T2 cancel-vs-recover-orphan.
 *
 * Pins workspace-context ordering: recoverOrphaned() runs to
 * completion before any cancel(id) call can see a still-running
 * orphan row. Without this ordering pin, a refactor that lazy-loads
 * `recoverOrphaned()` could let cancel(id) race the orphan-sweep
 * and produce inconsistent terminal kinds.
 *
 * The ADR's wording suggests pinning the route-layer ordering in
 * server/test/, but the actual ordering invariant — "recoverOrphaned
 * completes synchronously before user calls" — is testable at the
 * TaskManager layer. We mirror the production sequence (pre-write
 * `running` row → construct manager → await recoverOrphaned() →
 * cancel) and assert that by the time cancel runs, the row is
 * already terminal (failure:orphan), so cancel throws
 * InvalidTransition.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidTransition, Task } from "../src/index.js";
import { type CancelFixture, setupCancelFixture, teardownCancelFixture } from "./cancel-fixture.js";

let fx: CancelFixture;

beforeEach(async () => {
  fx = await setupCancelFixture();
});
afterEach(async () => {
  await teardownCancelFixture(fx);
});

describe("TaskManager.cancel — vs recoverOrphaned", () => {
  it("after recoverOrphaned the row is failure:orphan; cancel then throws InvalidTransition", async () => {
    const id = "20260518-cccccccc";
    const workdir = path.join(fx.tasksDir, id);
    await mkdir(workdir, { recursive: true });
    const orphan = Task.fromStored({
      id,
      agent: "demo",
      brief: "orphan",
      status: "running",
      // No pid → recoverOrphaned treats as dead and marks failure.
      metadata: { runtime: "copilot" },
      createdAt: "2026-05-18T01:00:00.000Z",
      startedAt: "2026-05-18T01:00:01.000Z",
    });
    await fx.repo.save(orphan);

    // Production sequence: WorkspaceContext awaits recoverOrphaned()
    // synchronously before serving any user request (per
    // workspace-context.ts: the context's constructor / init is what
    // gates user verbs).
    await fx.m.recoverOrphaned();

    // The orphan is now terminal — failure:orphan.
    const afterRecover = await fx.m.get(id);
    expect(afterRecover?.status).toBe("failure");
    expect(afterRecover?.failure?.kind).toBe("orphan");

    // cancel() against this terminal row throws InvalidTransition
    // ('failure' → 'cancel'). The route maps to 409.
    const err = await fx.m.cancel(id).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(InvalidTransition);
    expect((err as InvalidTransition).from).toBe("failure");
  });
});
