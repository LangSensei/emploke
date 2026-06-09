/**
 * Runtime tests for the pure validators in `src/validate.ts`.
 *
 * Covers the id-grammar contract (UUIDv4 always; legacy `<date>-<8hex>`
 * for workflow ids only, lowercase-only) and the closed-enum
 * shape checks. Pure functions, no I/O, no fixtures — same shape
 * as `schema.test.ts` but at the validator layer.
 */

import { describe, expect, it } from "vitest";
import {
  InvalidWorkflowIdError,
  InvalidWorkflowNodeIdError,
  WorkflowEnumValueCorruptionError,
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

  it("generateWorkflowId() emits the `<YYYYMMDD>-<8hex>` shape", () => {
    // The generator mirrors `@emploke/task`'s `generateTaskId` —
    // UTC date prefix + 4 random bytes hex-encoded. The grammar
    // still accepts UUIDv4 on the read side for pre-v2.2 rows;
    // new ids only ever take this shape.
    const id = generateWorkflowId();
    expect(id).toMatch(/^\d{8}-[0-9a-f]{8}$/);
  });

  it("generateWorkflowNodeId() returns a string that passes assertValidWorkflowNodeId", () => {
    for (let i = 0; i < 10; i++) {
      const id = generateWorkflowNodeId();
      expect(() => assertValidWorkflowNodeId(id)).not.toThrow();
    }
  });

  it("generateWorkflowId() honors the injected now + randomBytes seams", () => {
    const now = () => new Date("2026-05-22T10:11:12.000Z");
    const randomBytes = (n: number) => Buffer.alloc(n, 0xab);
    const id = generateWorkflowId(now, randomBytes);
    expect(id).toBe("20260522-abababab");
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
    expect(() => assertValidWorkflowStatusEnum("archived")).toThrowError(WorkflowEnumValueCorruptionError);
  });

  it("rejects the empty string", () => {
    expect(() => assertValidWorkflowStatusEnum("")).toThrowError(WorkflowEnumValueCorruptionError);
  });
});

describe("assertValidWorkflowNodeStatusEnum", () => {
  it("accepts each valid value", () => {
    for (const s of ["not_started", "ready", "running", "succeeded", "failed", "cancelled"]) {
      expect(() => assertValidWorkflowNodeStatusEnum(s)).not.toThrow();
    }
  });

  it("rejects an unknown value", () => {
    expect(() => assertValidWorkflowNodeStatusEnum("paused")).toThrowError(WorkflowEnumValueCorruptionError);
  });

  it("rejects the empty string", () => {
    expect(() => assertValidWorkflowNodeStatusEnum("")).toThrowError(WorkflowEnumValueCorruptionError);
  });
});

describe("assertValidWorkflowNodeKind (closed enum: 'coordinator' | 'worker')", () => {
  it("accepts the two NodeKind values", () => {
    expect(() => assertValidWorkflowNodeKind("worker")).not.toThrow();
    expect(() => assertValidWorkflowNodeKind("coordinator")).not.toThrow();
  });

  it("rejects values outside the closed NodeKind enum", () => {
    // The substrate's `NodeKind` is `'coordinator' | 'worker'`. Any
    // other persisted value signals schema corruption or a row
    // written by an older binary; the validator surfaces it as a
    // shape error so entity round-trips fail loudly at
    // `fromRow()` rather than smuggling junk into the typed runtime.
    for (const bad of ["task", "evaluator", "future-kind-99", "Worker", "WORKER", "human"]) {
      expect(() => assertValidWorkflowNodeKind(bad), `expected reject: ${bad}`).toThrowError(
        WorkflowNodeKindShapeError,
      );
    }
  });

  it("rejects the empty string with WorkflowNodeKindShapeError (not WorkflowEnumValueCorruptionError)", () => {
    expect(() => assertValidWorkflowNodeKind("")).toThrowError(WorkflowNodeKindShapeError);
  });

  it("rejects non-string inputs with WorkflowNodeKindShapeError", () => {
    for (const bad of [123, {}, null, undefined, []]) {
      expect(() => assertValidWorkflowNodeKind(bad)).toThrowError(WorkflowNodeKindShapeError);
    }
  });
});
