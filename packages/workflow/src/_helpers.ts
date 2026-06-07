/**
 * Pkg-internal helpers shared between service / repository.
 * Pure functions; throw `WorkflowError` subclasses on invalid input.
 */

import { WorkflowError } from "./errors.js";

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
