/**
 * Shared in-memory test harness for `@emploke/workflow` service /
 * repository tests. Mirrors the structure of
 * `packages/schedule/test/_helpers.ts`.
 *
 * The fake kind handlers are stub implementations of
 * `WorkflowNodeKindHandler`:
 *
 *   - `validate` is identity-by-default; tests can swap the fn to
 *     assert call args or simulate validate-failure flows.
 *   - `dispatch` records calls and returns `unit-N`; the substrate
 *     ignores the returned `unitId` (see types.ts: "the substrate
 *     does NOT persist this id").
 *   - `hasInFlightForNode` reads from `inFlightSet`; defaults to
 *     `false`.
 *   - `cancel` records calls; throws when `cancelShouldThrow` is set
 *     (lets tests prove the substrate still marks the node cancelled
 *     even if the handler fails).
 *
 * The harness wires a `WorkflowService` over an in-memory SQLite +
 * a stub handler for kind `"coordinator"` (auto-registered because
 * every service flow needs SOME coord handler) and one for kind
 * `"task"` (auto-registered because all the read-only / mutation
 * tests use both).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import pino from "pino";
import { openTestWorkflowDb } from "../src/testing.js";
import type { WorkflowNodeKindHandler, WorkflowNodeValidateCtx } from "../src/types.js";
import { WorkflowRepository } from "../src/workflow-repository.js";
import { WorkflowService } from "../src/workflow-service.js";

export interface ValidateCall {
  readonly spec: unknown;
  readonly ctx: WorkflowNodeValidateCtx;
}

export interface DispatchCall {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly spec: unknown;
  readonly nodeDir: string;
}

export interface StubHandler extends WorkflowNodeKindHandler {
  readonly validateCalls: ValidateCall[];
  readonly dispatchCalls: DispatchCall[];
  readonly cancelCalls: string[];
  /** Nodes considered to have in-flight units. */
  readonly inFlightSet: Set<string>;
  /** When true, the next dispatch call throws. */
  dispatchShouldThrow: boolean;
  /** When true, the next cancel call throws. */
  cancelShouldThrow: boolean;
  /** Override the `validate` return value; defaults to identity. */
  validateReturnValue: unknown | undefined;
  /** Override the `validate` behavior to throw. */
  validateShouldThrow: Error | null;
}

export function makeStubHandler(): StubHandler {
  const validateCalls: ValidateCall[] = [];
  const dispatchCalls: DispatchCall[] = [];
  const cancelCalls: string[] = [];
  const inFlightSet = new Set<string>();
  let seq = 0;
  const stub: StubHandler = {
    validateCalls,
    dispatchCalls,
    cancelCalls,
    inFlightSet,
    dispatchShouldThrow: false,
    cancelShouldThrow: false,
    validateReturnValue: undefined,
    validateShouldThrow: null,
    async validate(spec, ctx) {
      validateCalls.push({ spec, ctx });
      if (stub.validateShouldThrow !== null) throw stub.validateShouldThrow;
      return stub.validateReturnValue !== undefined ? stub.validateReturnValue : spec;
    },
    async dispatch(opts) {
      dispatchCalls.push(opts);
      seq += 1;
      if (stub.dispatchShouldThrow) {
        stub.dispatchShouldThrow = false;
        throw new Error("stub dispatch failure");
      }
      return { unitId: `unit-${seq}` };
    },
    async hasInFlightForNode(nodeId) {
      return inFlightSet.has(nodeId);
    },
    async cancel(nodeId) {
      cancelCalls.push(nodeId);
      if (stub.cancelShouldThrow) {
        stub.cancelShouldThrow = false;
        throw new Error("stub cancel failure");
      }
    },
  };
  return stub;
}

export interface WorkflowTestHandle {
  readonly service: WorkflowService;
  readonly repo: WorkflowRepository;
  readonly coordHandler: StubHandler;
  readonly taskHandler: StubHandler;
  readonly db: ReturnType<typeof openTestWorkflowDb>;
  readonly workspaceDir: string;
  readonly nowRef: { value: Date };
  setNow(d: Date): void;
  close(): void;
}

export function makeWorkflowTestHandle(
  opts: {
    readonly initialNow?: Date;
    readonly randomUUID?: () => string;
    readonly logger?: Logger;
    readonly coordHandler?: StubHandler;
    readonly taskHandler?: StubHandler;
    readonly skipAutoRegister?: boolean;
  } = {},
): WorkflowTestHandle {
  const db = openTestWorkflowDb();
  const workspaceDir = mkdtempSync(path.join(tmpdir(), "wf-test-"));
  const coordHandler = opts.coordHandler ?? makeStubHandler();
  const taskHandler = opts.taskHandler ?? makeStubHandler();
  const nowRef = { value: opts.initialNow ?? new Date("2026-06-07T00:00:00.000Z") };
  const repo = new WorkflowRepository({ db: db.db });
  const service = new WorkflowService({
    repo,
    db: db.db,
    workspaceDir,
    now: () => nowRef.value,
    ...(opts.randomUUID !== undefined ? { randomUUID: opts.randomUUID } : {}),
    ...(opts.logger !== undefined
      ? { logger: opts.logger }
      : { logger: pino({ level: "silent" }) }),
  });
  if (opts.skipAutoRegister !== true) {
    service.registerKind("coordinator", coordHandler);
    service.registerKind("task", taskHandler);
  }
  return {
    service,
    repo,
    coordHandler,
    taskHandler,
    db,
    workspaceDir,
    nowRef,
    setNow(d) {
      nowRef.value = d;
    },
    close() {
      db.close();
      rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
}

/**
 * Sequence generator that yields a fixed list of UUIDs in order.
 * Throws when exhausted so tests fail loudly instead of accidentally
 * minting random ids.
 */
export function fixedRandomUUID(ids: readonly string[]): () => string {
  let i = 0;
  return () => {
    const id = ids[i];
    if (id === undefined) throw new Error("fixedRandomUUID: out of ids");
    i++;
    return id;
  };
}

/**
 * A pool of valid UUIDv4 strings used across tests to make
 * assertions readable. Both workflow ids and node ids accept
 * UUIDv4 — the substrate's id generator emits UUIDv4 for both.
 */
export const VALID_UUIDS: readonly string[] = [
  "550e8400-e29b-41d4-a716-446655440000",
  "550e8400-e29b-41d4-a716-446655440001",
  "550e8400-e29b-41d4-a716-446655440002",
  "550e8400-e29b-41d4-a716-446655440003",
  "550e8400-e29b-41d4-a716-446655440004",
  "550e8400-e29b-41d4-a716-446655440005",
  "550e8400-e29b-41d4-a716-446655440006",
  "550e8400-e29b-41d4-a716-446655440007",
  "550e8400-e29b-41d4-a716-446655440008",
  "550e8400-e29b-41d4-a716-446655440009",
  "550e8400-e29b-41d4-a716-44665544000a",
  "550e8400-e29b-41d4-a716-44665544000b",
  "550e8400-e29b-41d4-a716-44665544000c",
  "550e8400-e29b-41d4-a716-44665544000d",
  "550e8400-e29b-41d4-a716-44665544000e",
  "550e8400-e29b-41d4-a716-44665544000f",
];

/**
 * Bootstrap a workflow + initial coord by invoking `createWorkflow`
 * with default args. Returns the created ids. Tests that exercise
 * non-create paths use this to avoid repeating the bootstrap.
 */
export async function bootstrap(
  h: WorkflowTestHandle,
  args: { readonly coordinatorAgent?: string; readonly brief?: string } = {},
): Promise<{ readonly workflowId: string; readonly initialCoordNodeId: string }> {
  return h.service.createWorkflow({
    brief: args.brief ?? "test workflow",
    coordinatorAgent: args.coordinatorAgent ?? "coord-agent",
  });
}
