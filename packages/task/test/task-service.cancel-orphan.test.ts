/**
 * cancel-orphan path: pre-write a `running` row WITHOUT going
 * through dispatch (so the manager's `live` map has no entry for
 * it), then call cancel(id). The cancel routes through
 * `applyTerminal` with a synthesised cascade-cancel decision so the
 * persisted shape matches the normal-path output. Asserts:
 * status='cancelled', cancellation.kind='cascade', exit code /
 * signal NOT mirrored into metadata, plus the operator-visible warn.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskEntity } from "../src/task-entity.js";
import {
  type CancelFixture,
  captureLogger,
  setupCancelFixture,
  teardownCancelFixture,
} from "./cancel-fixture.js";

let fx: CancelFixture;
let warnCalls: ReturnType<typeof captureLogger>;

beforeEach(async () => {
  warnCalls = captureLogger();
  fx = await setupCancelFixture({ logger: warnCalls.logger });
});
afterEach(async () => {
  await teardownCancelFixture(fx);
});

describe("TaskService.cancel — orphan path", () => {
  it("cancels an orphan running row through applyTerminal (kind='orphan')", async () => {
    const id = "20260518-deadbeef";
    const workdir = path.join(fx.tasksDir, id);
    await mkdir(workdir, { recursive: true });
    const orphan = TaskEntity.fromStored({
      id,
      agent: "demo",
      brief: "orphan to cancel",
      origin: "standalone",
      status: "running",
      metadata: { pid: 99999, runtime: "copilot" },
      createdAt: "2026-05-18T01:00:00.000Z",
      startedAt: "2026-05-18T01:00:01.000Z",
    });
    await fx.repo.save(orphan);

    const cancelled = await fx.m.cancel(id);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancellation).toEqual({
      kind: "cascade",
      message: "cancelled (recovered from inconsistent state)",
    });
    // exit code / signal are no longer mirrored into metadata; the
    // orphan-cancel synthesises a cancellation payload only.
    expect(cancelled.metadata.exitCode).toBeUndefined();
    expect(cancelled.metadata.exitSignal).toBeUndefined();

    // Operator-visible warning.
    const warns = warnCalls.calls.filter((c) =>
      c.msg.includes("cancelling row in running status with no live subprocess (orphan)"),
    );
    expect(warns).toHaveLength(1);
  });
});
