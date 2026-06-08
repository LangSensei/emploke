import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrap,
  fixedRandomUUID,
  makeWorkflowTestHandle,
  VALID_UUIDS,
  type WorkflowTestHandle,
} from "./_helpers.js";

describe("WorkflowService — list", () => {
  let h: WorkflowTestHandle;

  beforeEach(() => {
    h = makeWorkflowTestHandle({ randomUUID: fixedRandomUUID(VALID_UUIDS) });
  });

  afterEach(() => {
    h.close();
  });

  it("returns [] when no workflows exist", async () => {
    const list = await h.service.list();
    expect(list).toEqual([]);
  });

  it("returns workflows newest-first by created_at", async () => {
    h.setNow(new Date("2026-06-07T00:00:00.000Z"));
    const a = await bootstrap(h, { brief: "first" });
    h.setNow(new Date("2026-06-07T00:00:01.000Z"));
    const b = await bootstrap(h, { brief: "second" });
    h.setNow(new Date("2026-06-07T00:00:02.000Z"));
    const c = await bootstrap(h, { brief: "third" });
    const list = await h.service.list();
    expect(list.map((wf) => wf.id)).toEqual([c.workflowId, b.workflowId, a.workflowId]);
  });

  it("narrows by status when supplied", async () => {
    const a = await bootstrap(h, { brief: "alpha" });
    const b = await bootstrap(h, { brief: "beta" });
    // Cancel one workflow to flip it to a terminal status.
    await h.service.cancelWorkflow({ workflowId: a.workflowId });

    const running = await h.service.list({ status: "running" });
    expect(running.map((wf) => wf.id)).toEqual([b.workflowId]);

    const cancelled = await h.service.list({ status: "cancelled" });
    expect(cancelled.map((wf) => wf.id)).toEqual([a.workflowId]);

    const succeeded = await h.service.list({ status: "succeeded" });
    expect(succeeded).toEqual([]);
  });

  it("returns [] when status filter does not match any rows", async () => {
    await bootstrap(h, { brief: "only-running" });
    const failed = await h.service.list({ status: "failed" });
    expect(failed).toEqual([]);
  });
});
