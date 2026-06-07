/**
 * Pkg-internal helpers shared between service / repository.
 * Pure functions; throw `WorkflowError` subclasses on invalid input.
 */

import { WorkflowError } from "./errors.js";

/**
 * Kind names appear in `workflow_nodes.kind` (a TEXT column) and in
 * error messages quoted back to operators. The grammar is
 * deliberately narrow:
 *   - lowercase ASCII letter first
 *   - then any of lowercase letters, digits, underscore, hyphen
 *
 * Rules out empty / whitespace-only registrations and forbids
 * special characters that might collide with JSON-path syntax or
 * future URL-discriminated route segments.
 */
const KIND_NAME_RE = /^[a-z][a-z0-9_-]*$/;

export function assertValidKindName(kind: unknown): asserts kind is string {
  if (typeof kind !== "string" || !KIND_NAME_RE.test(kind)) {
    throw new WorkflowError(
      `Invalid workflow kind name: ${JSON.stringify(kind)}. Must match ${KIND_NAME_RE.source}`,
    );
  }
}

/**
 * Coordinator-kind specs persist their controlling agent's FQN as
 * `spec.agent`. The substrate's denormalization (`workflows.
 * coordinator_agent`) reads this opaquely; the field is a non-empty
 * string by contract. Throws `WorkflowError` when the contract is
 * violated.
 */
export function assertCoordinatorSpecAgent(spec: unknown): asserts spec is { agent: string } {
  if (
    spec === null ||
    typeof spec !== "object" ||
    !("agent" in (spec as Record<string, unknown>)) ||
    typeof (spec as { agent: unknown }).agent !== "string" ||
    (spec as { agent: string }).agent.length === 0
  ) {
    throw new WorkflowError(
      `Coordinator-kind spec must have a non-empty string "agent" field, got ${JSON.stringify(spec)}`,
    );
  }
}
