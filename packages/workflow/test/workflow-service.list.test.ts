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

  it("narrows by coordinatorAgent when supplied", async () => {
    const a = await bootstrap(h, { brief: "alpha", coordinatorAgent: "agent-alpha" });
    const b = await bootstrap(h, { brief: "beta", coordinatorAgent: "agent-beta" });

    const alpha = await h.service.list({ coordinatorAgent: "agent-alpha" });
    expect(alpha.map((wf) => wf.id)).toEqual([a.workflowId]);

    const beta = await h.service.list({ coordinatorAgent: "agent-beta" });
    expect(beta.map((wf) => wf.id)).toEqual([b.workflowId]);

    const none = await h.service.list({ coordinatorAgent: "agent-missing" });
    expect(none).toEqual([]);
  });

  it("narrows by createdSince (ISO lower bound, inclusive)", async () => {
    h.setNow(new Date("2026-06-07T00:00:00.000Z"));
    const a = await bootstrap(h, { brief: "old" });
    h.setNow(new Date("2026-06-07T00:00:02.000Z"));
    const b = await bootstrap(h, { brief: "new" });

    const sinceMid = await h.service.list({ createdSince: "2026-06-07T00:00:01.000Z" });
    expect(sinceMid.map((wf) => wf.id)).toEqual([b.workflowId]);

    const sinceAll = await h.service.list({ createdSince: "2026-06-07T00:00:00.000Z" });
    expect(sinceAll.map((wf) => wf.id)).toEqual([b.workflowId, a.workflowId]);

    const sinceFuture = await h.service.list({ createdSince: "2026-06-08T00:00:00.000Z" });
    expect(sinceFuture).toEqual([]);
  });

  it("narrows by idLike substring (case-sensitive, escapes LIKE metachars)", async () => {
    const a = await bootstrap(h, { brief: "alpha" });
    const b = await bootstrap(h, { brief: "beta" });
    // Both ids start with `<YYYYMMDD>-` — the date prefix matches both,
    // the 8-hex tail differs. Substring search on a unique tail fragment
    // should narrow to one row.
    const aTail = a.workflowId.slice(-4);
    const onlyA = await h.service.list({ idLike: aTail });
    expect(onlyA.map((wf) => wf.id)).toEqual([a.workflowId]);

    // A `%` typed by an operator must NOT widen the match — the repo
    // escapes LIKE metacharacters and emits an ESCAPE clause so a bare
    // `%` is interpreted as the literal character. Workflow ids contain
    // no `%`, so the result is empty (strict, not "all rows").
    const withPercent = await h.service.list({ idLike: "%" });
    expect(withPercent).toEqual([]);

    // Same defence for `_` — workflow ids contain no underscore, so a
    // bare `_` must narrow to nothing rather than match any-single-char.
    const withUnderscore = await h.service.list({ idLike: "_" });
    expect(withUnderscore).toEqual([]);

    // Spot-check the unrelated row is still in the table so the empty
    // results above aren't an artifact of bootstrap failing.
    const all = await h.service.list();
    expect(all.map((wf) => wf.id).sort()).toEqual([a.workflowId, b.workflowId].sort());
  });

  it("AND-combines all three filters when supplied together", async () => {
    h.setNow(new Date("2026-06-07T00:00:00.000Z"));
    const a = await bootstrap(h, { brief: "alpha", coordinatorAgent: "agent-alpha" });
    h.setNow(new Date("2026-06-07T00:00:02.000Z"));
    await bootstrap(h, { brief: "beta", coordinatorAgent: "agent-beta" });
    h.setNow(new Date("2026-06-07T00:00:03.000Z"));
    await bootstrap(h, { brief: "gamma", coordinatorAgent: "agent-alpha" });

    const aTail = a.workflowId.slice(-4);
    const narrow = await h.service.list({
      coordinatorAgent: "agent-alpha",
      createdSince: "2026-06-07T00:00:00.000Z",
      idLike: aTail,
    });
    expect(narrow.map((wf) => wf.id)).toEqual([a.workflowId]);
  });
});
