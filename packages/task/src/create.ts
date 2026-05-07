import { randomUUID } from "node:crypto";
import type { Task } from "./types.js";

export interface CreateParams {
  /** Logical agent identifier. Opaque to the kernel. */
  readonly agent: string;
  readonly instructions: string;
  /** Optional initial metadata (e.g. caller-supplied tags, parentTaskId). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Override task id (deterministic for tests; otherwise a UUID v4).
   */
  readonly id?: string;
  /**
   * Override creation timestamp (ISO 8601 UTC string, e.g.
   * `"2025-01-01T00:00:00.000Z"`). Defaults to `new Date().toISOString()`.
   * Deterministic-test seam.
   */
  readonly createdAt?: string;
}

/**
 * Construct a new task in `not_started` status.
 *
 * Pure factory: the only ambient effects are `randomUUID()` and
 * `new Date().toISOString()`; both are overridable via
 * {@link CreateParams.id} / {@link CreateParams.createdAt} for deterministic
 * tests.
 */
export function create(params: CreateParams): Task {
  return {
    id: params.id ?? randomUUID(),
    agent: params.agent,
    instructions: params.instructions,
    status: "not_started",
    metadata: { ...(params.metadata ?? {}) },
    createdAt: params.createdAt ?? new Date().toISOString(),
  };
}
