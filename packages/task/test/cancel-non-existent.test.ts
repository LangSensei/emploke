/**
 * ADR-001 §3.8 #5 — cancel-non-existent.
 *
 * cancel(id) on an id with no persisted row throws TaskNotFoundError.
 * The route layer maps that to 404.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskNotFoundError } from "../src/index.js";
import { type CancelFixture, setupCancelFixture, teardownCancelFixture } from "./cancel-fixture.js";

let fx: CancelFixture;

beforeEach(async () => {
  fx = await setupCancelFixture();
});
afterEach(async () => {
  await teardownCancelFixture(fx);
});

describe("TaskService.cancel — non-existent id", () => {
  it("throws TaskNotFoundError when no row exists for the id", async () => {
    await expect(fx.m.cancel("20260518-deadbeef")).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});
