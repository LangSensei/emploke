/**
 * Error hierarchy for `@emploke/workflows`. All errors extend
 * {@link WorkflowError} so callers can `instanceof` a coarse check
 * within the same realm; cross-realm callers (HTTP routes, CLI)
 * should branch on the stable `name` string literal.
 */

export class WorkflowError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "WorkflowError";
  }
}

export class WorkflowNotFoundError extends WorkflowError {
  override readonly name = "WorkflowNotFoundError";
  constructor(public readonly id: string) {
    super(`Workflow "${id}" not found`);
  }
}

export class WorkflowNodeNotFoundError extends WorkflowError {
  override readonly name = "WorkflowNodeNotFoundError";
  constructor(
    public readonly workflowId: string,
    public readonly nodeId: string,
  ) {
    super(`Workflow node "${nodeId}" not found in workflow "${workflowId}"`);
  }
}

export class InvalidWorkflowIdError extends WorkflowError {
  override readonly name = "InvalidWorkflowIdError";
  constructor(public readonly id: string) {
    super(`Invalid workflow id: "${id}"`);
  }
}

export class InvalidWorkflowNodeIdError extends WorkflowError {
  override readonly name = "InvalidWorkflowNodeIdError";
  constructor(public readonly id: string) {
    super(`Invalid workflow node id: "${id}"`);
  }
}

/**
 * Raised when an attempted state transition is illegal for the
 * current entity (node or workflow). Append-only/forward-only is the
 * primary invariant per CEO O5 — mutations on terminal nodes throw
 * this.
 */
export class InvalidWorkflowTransitionError extends WorkflowError {
  override readonly name = "InvalidWorkflowTransitionError";
  constructor(
    public readonly from: string,
    public readonly verb: string,
    extra?: string,
  ) {
    super(
      `Invalid workflow transition from "${from}" via "${verb}"${
        extra !== undefined ? `: ${extra}` : ""
      }`,
    );
  }
}

/** Raised when `addEdge` would introduce a cycle. */
export class WorkflowCycleError extends WorkflowError {
  override readonly name = "WorkflowCycleError";
  constructor(
    public readonly workflowId: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Adding edge ${from}->${to} would create a cycle in workflow ${workflowId}`);
  }
}

/**
 * Raised when `launchNode` is called on a node whose upstream
 * dependencies are not all `succeeded`.
 */
export class WorkflowNodeNotReadyError extends WorkflowError {
  override readonly name = "WorkflowNodeNotReadyError";
  constructor(
    public readonly workflowId: string,
    public readonly nodeId: string,
    public readonly reason: string,
  ) {
    super(`Workflow node ${nodeId} not ready to launch: ${reason}`);
  }
}

/** Raised when a node violates type/value invariants at hydration time. */
export class CorruptedWorkflowError extends WorkflowError {
  override readonly name = "CorruptedWorkflowError";
  constructor(
    public readonly id: string,
    detail: string,
  ) {
    super(`Workflow "${id}" is corrupted: ${detail}`);
  }
}
