/**
 * delete-on-terminal-statuses (positive coverage parallel to
 * delete-requires-terminal's negative coverage): delete a `success`
 * task / a `failure` task / a `cancelled` task — all succeed; row
 * is removed, workdir preserved (archive mode).
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  awaitTerminal,
  type CancelFixture,
  setupCancelFixture,
  teardownCancelFixture,
} from "./cancel-fixture.js";

let fx: CancelFixture;

beforeEach(async () => {
  fx = await setupCancelFixture({ autoExitOnKill: true });
});
afterEach(async () => {
  await teardownCancelFixture(fx);
});

async function workdirExists(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    return s.isDirectory();
  } catch {
    return false;
  }
}

describe("TaskService.delete — every terminal status is deletable (archive mode)", () => {
  it("deletes a success task; row gone, workdir preserved", async () => {
    const t = await fx.m.dispatch({ agent: "demo", brief: "ok" });
    fx.rt.handles[0]!.resolveExit({ code: 0, signal: null });
    await awaitTerminal(fx.m, t.id);

    await fx.m.delete(t.id);

    expect(await fx.m.get(t.id)).toBeNull();
    expect(await workdirExists(path.join(fx.tasksDir, t.id))).toBe(true);
  });

  it("deletes a failure task; row gone, workdir preserved", async () => {
    const t = await fx.m.dispatch({ agent: "demo", brief: "nope" });
    fx.rt.handles[0]!.resolveExit({ code: 17, signal: null });
    await awaitTerminal(fx.m, t.id);

    await fx.m.delete(t.id);

    expect(await fx.m.get(t.id)).toBeNull();
    expect(await workdirExists(path.join(fx.tasksDir, t.id))).toBe(true);
  });

  it("deletes a cancelled task; row gone, workdir preserved", async () => {
    const t = await fx.m.dispatch({ agent: "demo", brief: "stopme" });
    await fx.m.cancel(t.id);

    await fx.m.delete(t.id);

    expect(await fx.m.get(t.id)).toBeNull();
    expect(await workdirExists(path.join(fx.tasksDir, t.id))).toBe(true);
  });
});
