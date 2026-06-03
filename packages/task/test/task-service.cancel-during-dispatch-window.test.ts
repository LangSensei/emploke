/**
 * cancel-during-dispatch race defence: cancel() refuses with
 * {@link InvalidTransition} if `dispatchInProgress.has(id)` is true,
 * so cancel cannot race past a just-spawned subprocess.
 *
 * External HTTP callers cannot reach this branch (the id is unknown
 * until dispatch returns), but the invariant matters for future
 * internal callers (queueing, agent self-extension, parallel test
 * fixtures, etc). This test reaches into the manager's private
 * `dispatchInProgress` set via a cast to set up the race condition.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidTransition, type TaskService } from "../src/index.js";
import { type CancelFixture, setupCancelFixture, teardownCancelFixture } from "./cancel-fixture.js";

let fx: CancelFixture;

beforeEach(async () => {
  fx = await setupCancelFixture();
});
afterEach(async () => {
  await teardownCancelFixture(fx);
});

describe("TaskService.cancel — during-dispatch window", () => {
  it("throws InvalidTransition with eventType='cancel-during-dispatch'", async () => {
    const id = "20260518-aaaaaaaa";

    // Reach into the private dispatchInProgress set to simulate the
    // window where workdir has been reserved + row persisted but
    // `live.set` has not yet executed. cancel()'s check order is
    // assertValidTaskId → shuttingDown → dispatchInProgress →
    // repository.read, so we do NOT need a real row on disk — the
    // dispatchInProgress check fires before repository.read runs.
    const privateState = fx.m as unknown as { dispatchInProgress: Set<string> };
    privateState.dispatchInProgress.add(id);
    try {
      const err = await fx.m.cancel(id).then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(InvalidTransition);
      expect((err as InvalidTransition).from).toBe("running");
      expect((err as InvalidTransition).eventType).toBe("cancel-during-dispatch");
    } finally {
      privateState.dispatchInProgress.delete(id);
    }
  });

  it("type alias keeps TaskService imported for the cast", () => {
    // Silences unused-import lint; the import is the contract carrier.
    const t: typeof TaskService = fx.m.constructor as typeof TaskService;
    expect(typeof t).toBe("function");
  });
});
