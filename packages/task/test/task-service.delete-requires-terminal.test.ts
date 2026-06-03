/**
 * delete-requires-terminal: delete() on a non-terminal task throws
 * {@link InvalidTransition}. The route layer maps that to 409 with
 * a structured body `{ code: 'InvalidTransition', status: <running>,
 * transition: 'delete' }` so the dashboard can render a typed CTA
 * pointing at `cancel` instead of parsing prose.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidTransition } from "../src/index.js";
import { type CancelFixture, setupCancelFixture, teardownCancelFixture } from "./cancel-fixture.js";

let fx: CancelFixture;

beforeEach(async () => {
  fx = await setupCancelFixture({ autoExitOnKill: true });
});
afterEach(async () => {
  await teardownCancelFixture(fx);
});

describe("TaskService.delete — requires terminal status", () => {
  it("throws InvalidTransition when called on a running task; succeeds after cancel", async () => {
    const t = await fx.m.dispatch({ agent: "demo", brief: "delete-me-eventually" });
    // Live task → delete refuses.
    const err = await fx.m.delete(t.id).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(InvalidTransition);
    expect((err as InvalidTransition).from).toBe("running");
    expect((err as InvalidTransition).eventType).toBe("delete");

    // Cancel first, then delete — the canonical two-verb sequence.
    await fx.m.cancel(t.id);
    await fx.m.delete(t.id);
    expect(await fx.m.get(t.id)).toBeNull();
  });
});
