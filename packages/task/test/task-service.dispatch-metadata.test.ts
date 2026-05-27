/**
 * PR 1 of #61: `DispatchOpts.metadata` lets the caller seed
 * `Task.metadata` at dispatch time. Caller keys are shallow-merged
 * first, then the kernel adds `workdir` + `runtime` — so the kernel
 * always wins for those two keys (a scheduler can't spoof the runtime
 * column by passing `metadata: { runtime: '...' }`).
 */

import { describe, expect, it } from "vitest";
import { type CancelFixture, setupCancelFixture, teardownCancelFixture } from "./cancel-fixture.js";

describe("TaskService.dispatch — metadata plumbing", () => {
  it("shallow-merges caller-supplied metadata into the initial Task.metadata bag", async () => {
    const fx: CancelFixture = await setupCancelFixture({ autoExitOnKill: true });
    try {
      const t = await fx.m.dispatch({
        agent: "demo",
        brief: "metadata",
        origin: "schedule",
        metadata: { scheduleId: "abc", firedAt: "2026-05-19T01:00:00.000Z" },
      });
      // Caller-supplied keys present verbatim alongside the kernel
      // keys (workdir + runtime).
      expect(t.metadata.scheduleId).toBe("abc");
      expect(t.metadata.firedAt).toBe("2026-05-19T01:00:00.000Z");
      expect(t.metadata.workdir).toBeTypeOf("string");
      expect(t.metadata.runtime).toBe("copilot");
      // Round-trips through the repository so the persisted row carries
      // the same keys (and the `runtime` column promotion + re-fold
      // doesn't corrupt the schedule fields).
      const back = await fx.repo.read(t.id);
      expect(back?.metadata.scheduleId).toBe("abc");
      expect(back?.metadata.firedAt).toBe("2026-05-19T01:00:00.000Z");
      expect(back?.metadata.runtime).toBe("copilot");
    } finally {
      await teardownCancelFixture(fx);
    }
  });

  it("kernel wins: caller-supplied workdir / runtime keys are silently overridden", async () => {
    const fx: CancelFixture = await setupCancelFixture({ autoExitOnKill: true });
    try {
      const t = await fx.m.dispatch({
        agent: "demo",
        brief: "spoofed",
        metadata: {
          workdir: "/etc/passwd",
          runtime: "evil-runtime",
          tag: "kept",
        },
      });
      // workdir and runtime are dictated by the kernel — caller values
      // are silently overridden (no error thrown, no warning, just
      // ignored). The unrelated `tag` key is preserved.
      expect(t.metadata.workdir).not.toBe("/etc/passwd");
      expect(typeof t.metadata.workdir).toBe("string");
      expect(t.metadata.runtime).toBe("copilot");
      expect(t.metadata.tag).toBe("kept");
    } finally {
      await teardownCancelFixture(fx);
    }
  });

  it("undefined metadata is fine (default to {})", async () => {
    const fx: CancelFixture = await setupCancelFixture({ autoExitOnKill: true });
    try {
      const t = await fx.m.dispatch({ agent: "demo", brief: "no-meta" });
      // Only the kernel-supplied keys are present; no caller bag.
      expect(t.metadata.workdir).toBeTypeOf("string");
      expect(t.metadata.runtime).toBe("copilot");
    } finally {
      await teardownCancelFixture(fx);
    }
  });
});
