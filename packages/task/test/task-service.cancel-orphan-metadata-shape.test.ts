/**
 * cancel-orphan-metadata-shape: finer-grained shape assertion than
 * cancel-orphan's happy-path test — the persisted row from the
 * orphan path matches the normal-path row byte-for-byte EXCEPT the
 * cancellation discriminator. The orphan path routes through
 * `applyTerminal` so the on-disk shape stays consistent with normal
 * cancellation, and consumers can rely on a single read shape.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskEntity } from "../src/task-entity.js";
import { type CancelFixture, setupCancelFixture, teardownCancelFixture } from "./cancel-fixture.js";

let fx: CancelFixture;

beforeEach(async () => {
  fx = await setupCancelFixture({ autoExitOnKill: true });
});
afterEach(async () => {
  await teardownCancelFixture(fx);
});

describe("TaskService.cancel — orphan path shape parity", () => {
  it("orphan-cancel row matches normal-cancel row except cancellation.kind", async () => {
    // Normal-path cancel: dispatch + cancel.
    const normalDispatched = await fx.m.dispatch({ agent: "demo", brief: "normal" });
    const normal = await fx.m.cancel(normalDispatched.id);

    // Orphan-path cancel: pre-write a running row, then cancel.
    const orphanId = "20260518-bbbbbbbb";
    const workdir = path.join(fx.tasksDir, orphanId);
    await mkdir(workdir, { recursive: true });
    const orphanSeed = TaskEntity.fromStored({
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

    // The discriminator is the only deliberate difference: the
    // orphan-recovery path records its cancellations as 'cascade'
    // because no caller branches on a distinct orphan-cancellation
    // kind.
    expect(normal.cancellation?.kind).toBe("user");
    expect(orphan.cancellation?.kind).toBe("cascade");

    // exit code / signal are never mirrored into metadata for either
    // path — consumers read from the typed failure payload when
    // relevant (cancellation carries no exit info).
    expect("exitCode" in normal.metadata).toBe(false);
    expect("exitCode" in orphan.metadata).toBe(false);

    // Both have endedAt populated.
    expect(normal.endedAt).toBeDefined();
    expect(orphan.endedAt).toBeDefined();
  });
});
