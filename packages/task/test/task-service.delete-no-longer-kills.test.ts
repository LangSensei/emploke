/**
 * delete-no-longer-kills: spy on `handle.kill`; confirm delete() on
 * a terminal task never invokes it. The two verbs are orthogonal —
 * only cancel() and shutdown() touch subprocesses.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  awaitTerminal,
  type CancelFixture,
  setupCancelFixture,
  teardownCancelFixture,
} from "./cancel-fixture.js";

let fx: CancelFixture;

beforeEach(async () => {
  fx = await setupCancelFixture();
});
afterEach(async () => {
  await teardownCancelFixture(fx);
});

describe("TaskService.delete — no longer kills subprocesses", () => {
  it("delete on a success task never calls handle.kill", async () => {
    const t = await fx.m.dispatch({ agent: "demo", brief: "succeeds" });
    fx.rt.handles[0]!.resolveExit({ code: 0, signal: null });
    await awaitTerminal(fx.m, t.id);

    await fx.m.delete(t.id);

    expect(fx.rt.handles[0]!.killCount).toBe(0);
  });

  it("delete on a failure task never calls handle.kill", async () => {
    const t = await fx.m.dispatch({ agent: "demo", brief: "fails" });
    fx.rt.handles[0]!.resolveExit({ code: 17, signal: null });
    await awaitTerminal(fx.m, t.id);

    await fx.m.delete(t.id);

    expect(fx.rt.handles[0]!.killCount).toBe(0);
  });
});
