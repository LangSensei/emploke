/**
 * R-10 / ADR-001 §3.8 #11 — T4 cancel-orphan-metadata-shape.
 *
 * Finer-grained shape assertion than the cancel-orphan happy path:
 * the persisted row from the orphan path is byte-for-byte the same
 * structure as the normal path EXCEPT for `cancellation.kind ===
 * 'orphan'`. ADR-001 §3.4 calls this out as the R-4 shape-parity
 * requirement (orphan path routes through applyTerminal so the row
 * shape stays consistent).
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Task } from "../src/index.js";
import { type CancelFixture, setupCancelFixture, teardownCancelFixture } from "./cancel-fixture.js";

let fx: CancelFixture;

beforeEach(async () => {
  fx = await setupCancelFixture({ autoExitOnKill: true });
});
afterEach(async () => {
  await teardownCancelFixture(fx);
});

describe("TaskManager.cancel — orphan path shape parity", () => {
  it("orphan-cancel row matches normal-cancel row except cancellation.kind", async () => {
    // Normal-path cancel: dispatch + cancel.
    const normalDispatched = await fx.m.dispatch({ agent: "demo", brief: "normal" });
    const normal = await fx.m.cancel(normalDispatched.id);

    // Orphan-path cancel: pre-write a running row, then cancel.
    const orphanId = "20260518-bbbbbbbb";
    const workdir = path.join(fx.tasksDir, orphanId);
    await mkdir(workdir, { recursive: true });
    const orphanSeed = Task.fromStored({
      id: orphanId,
      agent: "demo",
      brief: "orphan",
      origin: "standalone",
      status: "running",
      metadata: { pid: 99998, runtime: "copilot" },
      createdAt: "2026-05-18T01:00:00.000Z",
      startedAt: "2026-05-18T01:00:01.000Z",
    });
    await fx.repo.save(orphanSeed);
    const orphan = await fx.m.cancel(orphanId);

    // Both reached the same terminal status.
    expect(normal.status).toBe("cancelled");
    expect(orphan.status).toBe("cancelled");

    // Both carry the cancellation field with the typed payload.
    expect(normal.cancellation).toBeDefined();
    expect(orphan.cancellation).toBeDefined();

    // The discriminator is the only deliberate difference. v4 folded
    // the pre-v4 'orphan' cancellation kind into 'cascade'.
    expect(normal.cancellation?.kind).toBe("user");
    expect(orphan.cancellation?.kind).toBe("cascade");

    // v4 (issue #119): exitCode / exitSignal are no longer mirrored
    // into metadata for either path — consumers read from the typed
    // failure payload when relevant (cancellation has no exit info).
    expect("exitCode" in normal.metadata).toBe(false);
    expect("exitCode" in orphan.metadata).toBe(false);

    // Both have endedAt populated.
    expect(normal.endedAt).toBeDefined();
    expect(orphan.endedAt).toBeDefined();
  });
});
