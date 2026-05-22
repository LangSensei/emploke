/**
 * ADR-001 §3.8 #2 — cancel-already-terminal.
 *
 * Once a task has reached a terminal status, `cancel(id)` must throw
 * {@link InvalidTransition}; the route layer maps that to 409.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidTransition } from "../src/index.js";
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

describe("TaskService.cancel — already-terminal input", () => {
  it("throws InvalidTransition on a success task", async () => {
    const t = await fx.m.dispatch({ agent: "demo", brief: "completes" });
    fx.rt.handles[0].resolveExit({ code: 0, signal: null });
    await awaitTerminal(fx.m, t.id);

    const err = await fx.m.cancel(t.id).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(InvalidTransition);
    expect((err as InvalidTransition).from).toBe("succeeded");
    expect((err as InvalidTransition).eventType).toBe("cancel");
  });

  it("throws InvalidTransition on a failure task", async () => {
    const t = await fx.m.dispatch({ agent: "demo", brief: "fails" });
    fx.rt.handles[0].resolveExit({ code: 17, signal: null });
    await awaitTerminal(fx.m, t.id);

    const err = await fx.m.cancel(t.id).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(InvalidTransition);
    expect((err as InvalidTransition).from).toBe("failed");
  });

  it("throws InvalidTransition on a cancelled task (second cancel)", async () => {
    const t = await fx.m.dispatch({ agent: "demo", brief: "cancel me" });
    fx.rt.autoExitOnKill = true;
    await fx.m.cancel(t.id);

    const err = await fx.m.cancel(t.id).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(InvalidTransition);
    expect((err as InvalidTransition).from).toBe("cancelled");
  });
});
