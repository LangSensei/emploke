/**
 * ADR-001 §3.8 #4 — cancel-during-shutdown.
 *
 * Fire shutdown() and cancel() concurrently for a live task. The
 * outcome is non-deterministic per ADR §3.1: shutdown might flip the
 * `shuttingDown` flag before cancel() takes its check, or cancel
 * might pass the check first. Either outcome is correct as long as:
 *   - the persisted status is one of {cancelled, failure(kind:shutdown)}
 *   - cancel() either resolves to a cancelled Task, OR
 *   - cancel() rejects with ManagerShuttingDownError (shutdown won before
 *     cancel's pre-check), OR
 *   - cancel() rejects with InvalidTransition (cancel passed the
 *     pre-check, but by the time it dropped into the live-kill block
 *     shutdown had already claimed the kill via `killReason='shutdown'`
 *     — the `wasFirstToCancel` guard then throws against the
 *     finalised terminal status).
 *
 * Test passes if BOTH the persisted status and the cancel() outcome
 * match one of these ADR-blessed combinations.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidTransition, ManagerShuttingDownError } from "../src/index.js";
import { type CancelFixture, setupCancelFixture, teardownCancelFixture } from "./cancel-fixture.js";

let fx: CancelFixture;

beforeEach(async () => {
  fx = await setupCancelFixture({ autoExitOnKill: true });
});
afterEach(async () => {
  await teardownCancelFixture(fx);
});

describe("TaskManager.cancel — concurrent with shutdown", () => {
  it("settles to one of the ADR-blessed combinations (cancelled | failure:shutdown × resolve | reject)", async () => {
    const dispatched = await fx.m.dispatch({ agent: "demo", brief: "race" });

    // Fire both verbs in the same microtask so the race is genuine.
    const cancelP = fx.m.cancel(dispatched.id);
    const shutdownP = fx.m.shutdown();

    const cancelOutcome = await cancelP.then(
      (task) => ({ ok: true as const, task }),
      (err) => ({ ok: false as const, err }),
    );
    await shutdownP;

    // Whichever branch we took, the persisted status must be terminal
    // and match one of the two ADR-blessed outcomes.
    const final = await fx.m.get(dispatched.id);
    expect(final).not.toBeNull();
    const status = final?.status;
    expect(status === "cancelled" || status === "failed").toBe(true);
    if (status === "cancelled") {
      expect(final?.cancellation?.kind).toBe("user");
    } else if (status === "failed") {
      expect(final?.failure?.kind).toBe("shutdown");
      expect(final?.failure?.message).toBe("server shutdown");
    }

    // cancel() resolved → return value's status is cancelled (cancel
    // won the live-kill race).
    // cancel() rejected → must be ManagerShuttingDownError (the pre-check
    // saw shuttingDown=true) OR InvalidTransition (the post-await guard
    // saw shutdown had already claimed the kill).
    if (cancelOutcome.ok) {
      expect(cancelOutcome.task.status).toBe("cancelled");
    } else {
      const err = cancelOutcome.err;
      const isManagerDown = err instanceof ManagerShuttingDownError;
      const isInvalidTransition = err instanceof InvalidTransition;
      expect(isManagerDown || isInvalidTransition).toBe(true);
    }
  });
});
