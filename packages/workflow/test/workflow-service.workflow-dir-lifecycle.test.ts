/**
 * Per-workflow shared dir lifecycle.
 *
 * The substrate manages `<workspaceDir>/workflows/<wfid>/` on behalf
 * of the coordinator: created (empty) on `createWorkflow`, preserved
 * across terminal status transitions for audit, and torn down
 * explicitly via the new {@link WorkflowService.purge} method. The
 * coord owns the internal layout (`decisions/`, `notes.md`, …); the
 * substrate only owns the wrapping directory's existence.
 *
 * These tests pin the substrate side of the contract:
 *   1. `createWorkflow` materialises `<workflowDir>` on disk.
 *   2. A failure in the create-tx (e.g. the runner's pre-tx validate
 *      throws) does not leave an orphan dir.
 *   3. A pre-existing dir is tolerated (mkdir `recursive: true`).
 *   4. Terminal status transitions preserve the dir.
 *   5. `purge(wfid)` removes the dir, is idempotent on a missing dir,
 *      and does NOT delete the workflow row.
 *   6. `purge` validates its argument shape (defense in depth against
 *      path traversal even though `safeJoinUnderRoot` is the real
 *      guard).
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidWorkflowIdError } from "../src/errors.js";
import { workflowDir } from "../src/paths.js";
import {
  bootstrap,
  fixedRandomBytes,
  fixedRandomUUID,
  makeWorkflowTestHandle,
  VALID_UUIDS,
  type WorkflowTestHandle,
} from "./_helpers.js";

describe("WorkflowService — workflowDir lifecycle", () => {
  let h: WorkflowTestHandle;

  beforeEach(() => {
    h = makeWorkflowTestHandle({
      randomUUID: fixedRandomUUID(VALID_UUIDS),
      randomBytes: fixedRandomBytes(["aaaaaaaa", "bbbbbbbb", "cccccccc"]),
      initialNow: new Date("2026-06-07T00:00:00.000Z"),
    });
  });

  afterEach(() => {
    h.close();
  });

  it("createWorkflow materialises <workspaceDir>/workflows/<wfid>/ on disk", async () => {
    const { workflowId } = await bootstrap(h);
    const wfDir = workflowDir(h.workspaceDir, workflowId);

    expect(existsSync(wfDir)).toBe(true);
    expect(statSync(wfDir).isDirectory()).toBe(true);
  });

  it("the created workflowDir is empty (coord owns the internal layout)", async () => {
    const { workflowId } = await bootstrap(h);
    const wfDir = workflowDir(h.workspaceDir, workflowId);
    // No `decisions/`, `notes.md`, etc — the substrate creates only
    // the wrapping directory.
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(wfDir)).toEqual([]);
  });

  it("a pre-existing workflowDir is tolerated (mkdir recursive: true is idempotent)", async () => {
    // Reserve the dir at the deterministic path the next workflow
    // id will resolve to. `randomBytes` seq is `aaaaaaaa` + the
    // pinned UTC date, so the first wfid is `20260607-aaaaaaaa`.
    const expectedWfId = "20260607-aaaaaaaa";
    const wfDir = workflowDir(h.workspaceDir, expectedWfId);
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(path.join(wfDir, "pre-existing.txt"), "leftover from a previous run");

    // Should not throw — and should NOT clobber the pre-existing file.
    const { workflowId } = await bootstrap(h);
    expect(workflowId).toBe(expectedWfId);
    expect(existsSync(path.join(wfDir, "pre-existing.txt"))).toBe(true);
  });

  it("validate-time failure does not leave an orphan workflowDir on disk", async () => {
    // Force the coord runner's validate path to throw BEFORE the
    // mkdir runs. We expect no dir to be materialised and no row
    // to be persisted.
    h.coordRunner.validateShouldThrow = new Error("simulated validate failure");

    await expect(bootstrap(h)).rejects.toThrow(/simulated validate failure/);

    // Wfid would have been `20260607-aaaaaaaa` had create proceeded.
    const wfDir = workflowDir(h.workspaceDir, "20260607-aaaaaaaa");
    expect(existsSync(wfDir)).toBe(false);
  });

  it("tx-failure inside createWorkflow rolls back the workflowDir (no orphan)", async () => {
    // Stub the repo's `insertWorkflow` to throw, simulating a
    // unique-constraint violation or any other DB-level write
    // failure. The substrate must `safeRmDir` the freshly created
    // workflowDir on the catch path so the next operator sees a
    // consistent fs/db state.
    const spy = vi.spyOn(h.repo, "insertWorkflow").mockImplementation(() => {
      throw new Error("simulated tx failure");
    });

    await expect(bootstrap(h)).rejects.toThrow(/simulated tx failure/);

    const wfDir = workflowDir(h.workspaceDir, "20260607-aaaaaaaa");
    expect(existsSync(wfDir)).toBe(false);

    spy.mockRestore();
  });

  it("workflow terminal status (succeeded) preserves the workflowDir for audit", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const wfDir = workflowDir(h.workspaceDir, workflowId);

    // Materialise a sentinel inside the wfDir so we can prove
    // nothing inside it was touched by the status transition.
    await writeFile(path.join(wfDir, "sentinel.txt"), "audit-evidence");

    // Drive the initial coord to a terminal state, then finish the
    // workflow as `succeeded`.
    await h.service.markNodeTerminal(workflowId, initialCoordNodeId, { status: "succeeded" });
    await h.service.finishWorkflow({ workflowId, outcome: "succeeded" });

    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.status).toBe("succeeded");

    // Dir AND sentinel survive.
    expect(existsSync(wfDir)).toBe(true);
    expect(existsSync(path.join(wfDir, "sentinel.txt"))).toBe(true);
  });

  it("workflow terminal status (failed) preserves the workflowDir for audit", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const wfDir = workflowDir(h.workspaceDir, workflowId);
    await writeFile(path.join(wfDir, "sentinel.txt"), "audit-evidence");

    await h.service.markNodeTerminal(workflowId, initialCoordNodeId, {
      status: "failed",
      reason: "boom",
    });
    await h.service.finishWorkflow({
      workflowId,
      outcome: "failed",
      failure: { kind: "coordinator", message: "boom" },
    });

    expect(existsSync(wfDir)).toBe(true);
    expect(existsSync(path.join(wfDir, "sentinel.txt"))).toBe(true);
  });

  it("workflow cancellation preserves the workflowDir for audit", async () => {
    const { workflowId } = await bootstrap(h);
    const wfDir = workflowDir(h.workspaceDir, workflowId);
    await writeFile(path.join(wfDir, "sentinel.txt"), "audit-evidence");

    await h.service.cancelWorkflow({
      workflowId,
      cancellation: { kind: "user", message: "operator pressed cancel" },
    });

    expect(existsSync(wfDir)).toBe(true);
    expect(existsSync(path.join(wfDir, "sentinel.txt"))).toBe(true);
  });

  // ─── purge ───────────────────────────────────────────────────

  it("purge removes the workflowDir from disk", async () => {
    const { workflowId } = await bootstrap(h);
    const wfDir = workflowDir(h.workspaceDir, workflowId);
    await mkdir(path.join(wfDir, "decisions"), { recursive: true });
    await writeFile(path.join(wfDir, "decisions", "wake-1.md"), "first decision");

    await h.service.purge(workflowId);

    expect(existsSync(wfDir)).toBe(false);
  });

  it("purge is idempotent — second call on an already-purged workflow is a no-op", async () => {
    const { workflowId } = await bootstrap(h);
    const wfDir = workflowDir(h.workspaceDir, workflowId);

    await h.service.purge(workflowId);
    expect(existsSync(wfDir)).toBe(false);

    // Second call: must not throw.
    await expect(h.service.purge(workflowId)).resolves.toBeUndefined();
    expect(existsSync(wfDir)).toBe(false);
  });

  it("purge does NOT remove the workflow row (only the fs dir)", async () => {
    const { workflowId } = await bootstrap(h);

    await h.service.purge(workflowId);

    // The workflow row is still readable.
    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.id).toBe(workflowId);
    expect(wf.status).toBe("running");
  });

  it("purge can be called on a non-existent workflow id (silent no-op)", async () => {
    // No row created — but `purge` is best-effort cleanup so it
    // tolerates an unknown id rather than throwing. Operators
    // running a sweep should not need to first confirm-exists.
    await expect(h.service.purge("20990101-deadbeef")).resolves.toBeUndefined();
  });

  it("purge validates workflow id shape (rejects malformed input)", async () => {
    await expect(h.service.purge("not-a-valid-id")).rejects.toBeInstanceOf(InvalidWorkflowIdError);
    // Path-traversal attempt — `assertValidWorkflowId` rejects on
    // shape; `safeJoinUnderRoot` is defense in depth below it.
    await expect(h.service.purge("../escape")).rejects.toBeInstanceOf(InvalidWorkflowIdError);
  });

  it("purge after workflow terminal status still works (cancel + purge round-trip)", async () => {
    const { workflowId } = await bootstrap(h);
    const wfDir = workflowDir(h.workspaceDir, workflowId);

    await h.service.cancelWorkflow({
      workflowId,
      cancellation: { kind: "user", message: "stop" },
    });
    // Status flipped — but the dir still exists.
    expect(existsSync(wfDir)).toBe(true);

    await h.service.purge(workflowId);
    expect(existsSync(wfDir)).toBe(false);
    // Row still present even after status terminal + purge.
    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.status).toBe("cancelled");
  });

  it("createWorkflow yields disjoint workflowDirs across two consecutive workflows", async () => {
    const { workflowId: wfa } = await bootstrap(h);
    const { workflowId: wfb } = await bootstrap(h);
    expect(wfa).not.toBe(wfb);

    const dirA = workflowDir(h.workspaceDir, wfa);
    const dirB = workflowDir(h.workspaceDir, wfb);
    expect(dirA).not.toBe(dirB);
    expect(existsSync(dirA)).toBe(true);
    expect(existsSync(dirB)).toBe(true);
  });
});
