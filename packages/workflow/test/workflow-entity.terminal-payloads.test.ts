import { describe, expect, it } from "vitest";
import { WorkflowEntity } from "../src/workflow-entity.js";

const NOW = "2026-06-07T00:00:00.000Z";
const WF_ID = "550e8400-e29b-41d4-a716-446655440000";

function rowBase(over?: Partial<Parameters<typeof WorkflowEntity.fromRow>[0]>) {
  return {
    id: WF_ID,
    brief: "b",
    details: null,
    coordinatorAgent: "agent-1",
    status: "running" as const,
    metadata: "{}",
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    success: null,
    failure: null,
    cancellation: null,
    ...over,
  } as Parameters<typeof WorkflowEntity.fromRow>[0];
}

describe("WorkflowEntity — v2.2 terminal payload columns", () => {
  describe("succeeded", () => {
    it("round-trips success.output", () => {
      const e = WorkflowEntity.fromRow(
        rowBase({
          status: "succeeded",
          endedAt: NOW,
          success: JSON.stringify({ output: "All sub-runs green." }),
        }),
      );
      expect(e.success).toEqual({ output: "All sub-runs green." });
      expect(e.failure).toBeUndefined();
      expect(e.cancellation).toBeUndefined();
      const row = e.toRow();
      expect(row.success).toBe(JSON.stringify({ output: "All sub-runs green." }));
      expect(row.failure).toBeNull();
      expect(row.cancellation).toBeNull();
    });

    it("accepts null success column on terminal status (legacy row tolerance)", () => {
      const e = WorkflowEntity.fromRow(rowBase({ status: "succeeded", endedAt: NOW }));
      expect(e.status).toBe("succeeded");
      expect(e.success).toBeUndefined();
    });

    it("rejects succeeded + failure column non-null (cross-field invariant)", () => {
      expect(() =>
        WorkflowEntity.fromRow(
          rowBase({
            status: "succeeded",
            endedAt: NOW,
            failure: JSON.stringify({ kind: "coordinator", message: "x" }),
          }),
        ),
      ).toThrow();
    });
  });

  describe("failed", () => {
    it("round-trips failure.kind + message", () => {
      const e = WorkflowEntity.fromRow(
        rowBase({
          status: "failed",
          endedAt: NOW,
          failure: JSON.stringify({ kind: "coordinator", message: "budget out" }),
        }),
      );
      expect(e.failure).toEqual({ kind: "coordinator", message: "budget out" });
      expect(e.success).toBeUndefined();
    });

    it("accepts null failure column on terminal status (legacy row tolerance)", () => {
      const e = WorkflowEntity.fromRow(rowBase({ status: "failed", endedAt: NOW }));
      expect(e.status).toBe("failed");
      expect(e.failure).toBeUndefined();
    });

    it("rejects failed + cancellation column non-null", () => {
      expect(() =>
        WorkflowEntity.fromRow(
          rowBase({
            status: "failed",
            endedAt: NOW,
            cancellation: JSON.stringify({ kind: "user", message: "x" }),
          }),
        ),
      ).toThrow();
    });

    it("rejects failure JSON with unknown kind", () => {
      expect(() =>
        WorkflowEntity.fromRow(
          rowBase({
            status: "failed",
            endedAt: NOW,
            failure: JSON.stringify({ kind: "bogus", message: "x" }),
          }),
        ),
      ).toThrow();
    });

    it("coerces legacy failure.kind 'coord' to 'coordinator' on read", () => {
      const e = WorkflowEntity.fromRow(
        rowBase({
          status: "failed",
          endedAt: NOW,
          failure: JSON.stringify({ kind: "coord", message: "legacy" }),
        }),
      );
      expect(e.failure).toEqual({ kind: "coordinator", message: "legacy" });
    });

    it("coerces legacy failure.kind 'internal' to 'coordinator' on read", () => {
      const e = WorkflowEntity.fromRow(
        rowBase({
          status: "failed",
          endedAt: NOW,
          failure: JSON.stringify({ kind: "internal", message: "engine" }),
        }),
      );
      expect(e.failure).toEqual({ kind: "coordinator", message: "engine" });
    });
  });

  describe("cancelled", () => {
    it("round-trips cancellation.kind + message", () => {
      const e = WorkflowEntity.fromRow(
        rowBase({
          status: "cancelled",
          endedAt: NOW,
          cancellation: JSON.stringify({ kind: "user", message: "stop" }),
        }),
      );
      expect(e.cancellation).toEqual({ kind: "user", message: "stop" });
    });

    it("accepts null cancellation column on terminal status (legacy row tolerance)", () => {
      const e = WorkflowEntity.fromRow(rowBase({ status: "cancelled", endedAt: NOW }));
      expect(e.cancellation).toBeUndefined();
    });

    it("rejects cancelled + success column non-null", () => {
      expect(() =>
        WorkflowEntity.fromRow(
          rowBase({
            status: "cancelled",
            endedAt: NOW,
            success: JSON.stringify({ output: "x" }),
          }),
        ),
      ).toThrow();
    });

    it("coerces legacy cancellation.kind 'cascade' to 'user' on read", () => {
      const e = WorkflowEntity.fromRow(
        rowBase({
          status: "cancelled",
          endedAt: NOW,
          cancellation: JSON.stringify({ kind: "cascade", message: "parent gone" }),
        }),
      );
      expect(e.cancellation).toEqual({ kind: "user", message: "parent gone" });
    });
  });

  describe("running", () => {
    it("rejects any payload column on a non-terminal row", () => {
      expect(() =>
        WorkflowEntity.fromRow(rowBase({ success: JSON.stringify({ output: "x" }) })),
      ).toThrow();
      expect(() =>
        WorkflowEntity.fromRow(
          rowBase({ failure: JSON.stringify({ kind: "coordinator", message: "x" }) }),
        ),
      ).toThrow();
      expect(() =>
        WorkflowEntity.fromRow(
          rowBase({ cancellation: JSON.stringify({ kind: "user", message: "x" }) }),
        ),
      ).toThrow();
    });
  });
});
