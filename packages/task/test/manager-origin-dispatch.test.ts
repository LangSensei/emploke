/**
 * Issue #119: dispatching a task with `origin: 'workflow'` should
 * persist the origin verbatim on the row and round-trip through the
 * repository.
 */

import { describe, expect, it } from "vitest";
import { type CancelFixture, setupCancelFixture, teardownCancelFixture } from "./cancel-fixture.js";

describe("TaskManager.dispatch — origin plumbing", () => {
  it("persists the explicit origin and round-trips through the repository", async () => {
    const fx: CancelFixture = await setupCancelFixture({ autoExitOnKill: true });
    try {
      const wf = await fx.m.dispatch({ agent: "demo", brief: "wf", origin: "workflow" });
      expect(wf.origin).toBe("workflow");
      const back = await fx.repo.read(wf.id);
      expect(back?.origin).toBe("workflow");
    } finally {
      await teardownCancelFixture(fx);
    }
  });

  it("defaults origin to 'standalone' when omitted", async () => {
    const fx = await setupCancelFixture({ autoExitOnKill: true });
    try {
      const std = await fx.m.dispatch({ agent: "demo", brief: "std" });
      expect(std.origin).toBe("standalone");
      const back = await fx.repo.read(std.id);
      expect(back?.origin).toBe("standalone");
    } finally {
      await teardownCancelFixture(fx);
    }
  });
});
