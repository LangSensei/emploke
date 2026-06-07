/**
 * Runtime tests for the pure validators in `src/validate.ts`.
 *
 * Covers the id-grammar contract (UUIDv4 always; legacy `<date>-<8hex>`
 * for workflow ids only, lowercase-only) and the closed-enum / open-
 * kind shape checks. Pure functions, no I/O, no fixtures — same shape
 * as `schema.test.ts` but at the validator layer.
 */

import { describe, expect, it } from "vitest";
import {
  InvalidWorkflowIdError,
  InvalidWorkflowNodeIdError,
  WorkflowEnumValueError,
  WorkflowNodeKindShapeError,
} from "../src/errors.js";
import {
  assertValidWorkflowId,
  assertValidWorkflowNodeId,
  assertValidWorkflowNodeKind,
  assertValidWorkflowNodeStatusEnum,
  assertValidWorkflowStatusEnum,
  generateWorkflowId,
  generateWorkflowNodeId,
} from "../src/validate.js";

// Sample UUIDv4 ids: identical bytes, one lowercase and one uppercase.
const UUID_V4_LOWER = "550e8400-e29b-41d4-a716-446655440000";
const UUID_V4_UPPER = "550E8400-E29B-41D4-A716-446655440000";

// Legacy `<YYYYMMDD>-<8 hex>` shape. Lowercase only; the regex has no
// `/i` flag, so the uppercase variant must be rejected.
const LEGACY_LOWER = "20260522-aaaaaaaa";
const LEGACY_UPPER = "20260522-AAAAAAAA";

describe("assertValidWorkflowId", () => {
  it("accepts a lowercase UUIDv4", () => {
    expect(() => assertValidWorkflowId(UUID_V4_LOWER)).not.toThrow();
  });

  it("accepts an UPPERCASE UUIDv4", () => {
    expect(() => assertValidWorkflowId(UUID_V4_UPPER)).not.toThrow();
  });

  it("accepts the legacy <YYYYMMDD>-<8 lowercase hex> shape", () => {
    expect(() => assertValidWorkflowId(LEGACY_LOWER)).not.toThrow();
  });

  it("REJECTS the legacy shape with UPPERCASE hex (regex has no /i)", () => {
    expect(() => assertValidWorkflowId(LEGACY_UPPER)).toThrowError(InvalidWorkflowIdError);
  });

  it("rejects garbage strings", () => {
    for (const bad of [
      "",
      "foo",
      "no-dashes-here",
      "550e8400e29b41d4a716446655440000", // missing dashes
      "550e8400-e29b-31d4-a716-446655440000", // wrong version (3 instead of 4)
      "550e8400-e29b-41d4-c716-446655440000", // bad variant nibble (c not 8/9/a/b)
      "20260522-zzzzzzzz", // non-hex in legacy shape
      "2026052-aaaaaaaa", // 7-digit date in legacy shape
    ]) {
      expect(() => assertValidWorkflowId(bad), `expected reject: ${bad}`).toThrowError(
        InvalidWorkflowIdError,
      );
    }
  });

  it("rejects non-string inputs", () => {
    for (const bad of [123, { id: UUID_V4_LOWER }, null, undefined, [], true]) {
      expect(() => assertValidWorkflowId(bad)).toThrowError(InvalidWorkflowIdError);
    }
  });
});

describe("assertValidWorkflowNodeId", () => {
  it("accepts a lowercase UUIDv4", () => {
    expect(() => assertValidWorkflowNodeId(UUID_V4_LOWER)).not.toThrow();
  });

  it("accepts an UPPERCASE UUIDv4", () => {
    expect(() => assertValidWorkflowNodeId(UUID_V4_UPPER)).not.toThrow();
  });

  it("REJECTS the legacy <date>-<8hex> shape (node ids are UUIDv4 only)", () => {
    expect(() => assertValidWorkflowNodeId(LEGACY_LOWER)).toThrowError(InvalidWorkflowNodeIdError);
    expect(() => assertValidWorkflowNodeId(LEGACY_UPPER)).toThrowError(InvalidWorkflowNodeIdError);
  });

  it("rejects garbage strings", () => {
    for (const bad of ["", "foo", "550e8400-e29b-31d4-a716-446655440000"]) {
      expect(() => assertValidWorkflowNodeId(bad)).toThrowError(InvalidWorkflowNodeIdError);
    }
  });

  it("rejects non-string inputs", () => {
    for (const bad of [123, {}, null, undefined]) {
      expect(() => assertValidWorkflowNodeId(bad)).toThrowError(InvalidWorkflowNodeIdError);
    }
  });
});

describe("generateWorkflowId / generateWorkflowNodeId round-trips", () => {
  it("generateWorkflowId() returns a string that passes assertValidWorkflowId", () => {
    for (let i = 0; i < 10; i++) {
      const id = generateWorkflowId();
      expect(() => assertValidWorkflowId(id)).not.toThrow();
    }
  });

  it("generateWorkflowNodeId() returns a string that passes assertValidWorkflowNodeId", () => {
    for (let i = 0; i < 10; i++) {
      const id = generateWorkflowNodeId();
      expect(() => assertValidWorkflowNodeId(id)).not.toThrow();
    }
  });

  it("generateWorkflowId() honors the injected RNG seam", () => {
    const id = generateWorkflowId(() => UUID_V4_LOWER);
    expect(id).toBe(UUID_V4_LOWER);
    expect(() => assertValidWorkflowId(id)).not.toThrow();
  });

  it("generateWorkflowNodeId() honors the injected RNG seam", () => {
    const id = generateWorkflowNodeId(() => UUID_V4_LOWER);
    expect(id).toBe(UUID_V4_LOWER);
    expect(() => assertValidWorkflowNodeId(id)).not.toThrow();
  });
});

describe("assertValidWorkflowStatusEnum", () => {
  it("accepts each valid value", () => {
    for (const s of ["running", "succeeded", "failed", "cancelled"]) {
      expect(() => assertValidWorkflowStatusEnum(s)).not.toThrow();
    }
  });

  it("rejects an unknown value", () => {
    expect(() => assertValidWorkflowStatusEnum("archived")).toThrowError(WorkflowEnumValueError);
  });

  it("rejects the empty string", () => {
    expect(() => assertValidWorkflowStatusEnum("")).toThrowError(WorkflowEnumValueError);
  });
});

describe("assertValidWorkflowNodeStatusEnum", () => {
  it("accepts each valid value", () => {
    for (const s of ["not_started", "ready", "running", "succeeded", "failed", "cancelled"]) {
      expect(() => assertValidWorkflowNodeStatusEnum(s)).not.toThrow();
    }
  });

  it("rejects an unknown value", () => {
    expect(() => assertValidWorkflowNodeStatusEnum("paused")).toThrowError(WorkflowEnumValueError);
  });

  it("rejects the empty string", () => {
    expect(() => assertValidWorkflowNodeStatusEnum("")).toThrowError(WorkflowEnumValueError);
  });
});

describe("assertValidWorkflowNodeKind (open substrate: any non-empty string)", () => {
  it("accepts the baseline kinds", () => {
    expect(() => assertValidWorkflowNodeKind("task")).not.toThrow();
    expect(() => assertValidWorkflowNodeKind("coordinator")).not.toThrow();
  });

  it("accepts an arbitrary non-baseline kind (substrate is kind-agnostic)", () => {
    expect(() => assertValidWorkflowNodeKind("evaluator")).not.toThrow();
    expect(() => assertValidWorkflowNodeKind("future-kind-99")).not.toThrow();
  });

  it("rejects the empty string with WorkflowNodeKindShapeError (not WorkflowEnumValueError)", () => {
    expect(() => assertValidWorkflowNodeKind("")).toThrowError(WorkflowNodeKindShapeError);
  });

  it("rejects non-string inputs with WorkflowNodeKindShapeError", () => {
    for (const bad of [123, {}, null, undefined, []]) {
      expect(() => assertValidWorkflowNodeKind(bad)).toThrowError(WorkflowNodeKindShapeError);
    }
  });
});
