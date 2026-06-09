/**
 * Pkg-internal helpers shared between service / repository.
 * Pure functions; throw `WorkflowError` subclasses on invalid input.
 */

import { rm } from "node:fs/promises";
import type { Logger } from "pino";
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

/**
 * Best-effort recursive `rm` mirroring `@emploke/task`'s
 * `safeRm` in `task-service/_helpers.ts`. Idempotent (ENOENT is
 * suppressed by `force: true`); a real fs error is warn-logged but
 * not rethrown — used on rollback paths and `purge`, neither of
 * which can do anything useful with a failed cleanup.
 */
export async function safeRmDir(p: string, logger: Logger): Promise<void> {
  try {
    await rm(p, { recursive: true, force: true });
  } catch (err) {
    logger.warn(
      {
        path: p,
        err,
      },
      "workflow: failed to remove workflowDir during cleanup",
    );
  }
}
