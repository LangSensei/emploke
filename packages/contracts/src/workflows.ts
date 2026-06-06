/**
 * Wire-shape DTOs for the workflows HTTP / dispatch surface that are
 * NOT owned by `@emploke/workflow` (the workflow pkg is a
 * kind-agnostic substrate; per-kind wire shapes live here so the
 * substrate stays free of kind knowledge).
 *
 * Mirrors `./schedules.ts` byte-for-byte in role: the substrate
 * stores an opaque `{ kind: string, spec: unknown }` envelope; per-
 * kind wire types live here and are flattened (kind + flat fields)
 * for HTTP responses so dashboard / CLI consumers can read flat
 * `node.spec.agent` style without touching the envelope.
 *
 * See `packages/workflow/SPEC.md` §"v1.0.0 'task' kind contract" and
 * §"v1.0.0 'coordinator' kind contract" for the contract definitions
 * and the validation rules enforced by the kind handlers (which live
 * in `packages/api/src/wiring/`, Phase 4 in the v1 rollout).
 */

/**
 * Task-kind node spec payload. Flat, matches the body shape minus
 * the discriminator. Persisted opaquely as
 * `workflow_nodes.spec_json` via the substrate's envelope; consumed
 * flatly on the wire.
 *
 * Validation lives in the task-kind handler (Phase 4); a Phase 0
 * sketch of the rules:
 *
 *   1. `agent` non-empty string AND exists in catalog AND appears in
 *      the caller coord's `spec.agent`'s `dependencies.agents`.
 *   2. `brief` non-empty string, no `\n`/`\r`, length ≤ 200.
 *   3. `details` when present, must be string (empty allowed).
 *   4. `runtime` when present, must be non-empty string.
 */
export interface WorkflowTaskNodeSpec {
  /**
   * Worker agent FQN. MUST appear in the most recent coord node's
   * `spec.agent`'s `dependencies.agents` (validated by the
   * task-kind handler at insert time).
   */
  readonly agent: string;
  /** Single line, ≤ 200 chars. Mirrors `@emploke/task` `DispatchOpts.brief`. */
  readonly brief: string;
  /** Multi-line, optional. Mirrors `@emploke/task` `DispatchOpts.details`. */
  readonly details?: string;
  /** Optional runtime override. Mirrors `@emploke/task` `DispatchOpts.runtime`. */
  readonly runtime?: string;
}

/**
 * Coordinator-kind node spec payload. Every coord node carries its
 * own agent FQN (D14 in SPEC.md). When the substrate auto-inserts a
 * silent-retry coord (D20), it copies the predecessor's `spec_json`.
 * When the coord schedules a successor via mutation primitives, the
 * coord chooses what agent to use (D19) — inheritance is convention,
 * not enforced.
 *
 * Validation rules (Phase 4 handler):
 *
 *   1. `agent` non-empty string AND exists in catalog AND its
 *      `dependencies.skills` MUST include `emploke/coordinator`.
 */
export interface WorkflowCoordinatorNodeSpec {
  /** Coordinator agent FQN. */
  readonly agent: string;
}

/**
 * Flat wire projection for a task-kind workflow node spec. The
 * internal envelope `{ kind: "task", spec: { agent, brief, ... } }`
 * is flattened to `{ kind: "task", agent, brief, ... }` for HTTP
 * responses so existing dashboard / CLI code can read
 * `node.spec.agent` without unwrapping `spec`.
 */
export type WorkflowTaskNodeSpecWire = { readonly kind: "task" } & WorkflowTaskNodeSpec;

/** Flat wire projection for a coordinator-kind workflow node spec. */
export type WorkflowCoordinatorNodeSpecWire = {
  readonly kind: "coordinator";
} & WorkflowCoordinatorNodeSpec;

/**
 * Wire-shape spec on workflow node responses. Flat for the two
 * known v1 kinds (`task` / `coordinator`); opaque envelope for any
 * future kind the server projects through unchanged. When a third
 * concrete kind ships, add its flat wire shape here as another
 * union member.
 */
export type WorkflowNodeWireSpec =
  | WorkflowTaskNodeSpecWire
  | WorkflowCoordinatorNodeSpecWire
  | { readonly kind: string; readonly spec: unknown };
