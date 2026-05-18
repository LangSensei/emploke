/**
 * ADR-001 §3.8 #1 — cancel-running happy path.
 *
 * Dispatch a slow fixture, cancel it, assert the persisted row
 * carries the canonical user-cancellation payload and the timing
 * fields are set.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CancelFixture, setupCancelFixture, teardownCancelFixture } from "./cancel-fixture.js";

let fx: CancelFixture;

beforeEach(async () => {
  fx = await setupCancelFixture({ autoExitOnKill: true });
});
afterEach(async () => {
  await teardownCancelFixture(fx);
});

describe("TaskManager.cancel — happy path", () => {
  it("kills the live subprocess and persists status='cancelled' with kind='user'", async () => {
    const dispatched = await fx.m.dispatch({ agent: "demo", brief: "slow task" });

    const cancelled = await fx.m.cancel(dispatched.id);

    expect(cancelled.id).toBe(dispatched.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.endedAt).toBeDefined();
    expect(cancelled.cancellation).toEqual({ kind: "user", message: "cancelled by user" });

    // Re-read confirms the persisted row matches.
    const back = await fx.m.get(dispatched.id);
    expect(back?.status).toBe("cancelled");
    expect(back?.cancellation).toEqual({ kind: "user", message: "cancelled by user" });

    // Subprocess was killed exactly once.
    expect(fx.rt.handles[0].killed).toBe(true);
    expect(fx.rt.handles[0].killCount).toBe(1);
  });
});
