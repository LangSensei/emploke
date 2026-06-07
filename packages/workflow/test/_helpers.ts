/**
 * Shared in-memory test harness for `@emploke/workflow` service /
 * repository tests. Mirrors the structure of
 * `packages/schedule/test/_helpers.ts`.
 *
 * The fake kind runners are stub implementations of
 * `WorkflowNodeRunner`:
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
 *     even if the runner fails).
 *
 * The harness wires a `WorkflowService` over an in-memory SQLite with
 * a stub runner for `coordinator` and one for `worker`, injected at
 * compose time via the `runners: WorkflowRunners` field.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import pino from "pino";
import { openTestWorkflowDb } from "../src/testing.js";
import type { WorkflowNodeRunner, WorkflowNodeValidateCtx, WorkflowRunners } from "../src/types.js";
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

export interface StubRunner extends WorkflowNodeRunner {
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

export function makeStubRunner(): StubRunner {
  const validateCalls: ValidateCall[] = [];
  const dispatchCalls: DispatchCall[] = [];
  const cancelCalls: string[] = [];
  const inFlightSet = new Set<string>();
  let seq = 0;
  const stub: StubRunner = {
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
  readonly coordRunner: StubRunner;
  readonly workerRunner: StubRunner;
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
    readonly coordRunner?: StubRunner;
    readonly workerRunner?: StubRunner;
  } = {},
): WorkflowTestHandle {
  const db = openTestWorkflowDb();
  const workspaceDir = mkdtempSync(path.join(tmpdir(), "wf-test-"));
  const coordRunner = opts.coordRunner ?? makeStubRunner();
  const workerRunner = opts.workerRunner ?? makeStubRunner();
  const runners: WorkflowRunners = { coordinator: coordRunner, worker: workerRunner };
  const nowRef = { value: opts.initialNow ?? new Date("2026-06-07T00:00:00.000Z") };
  const repo = new WorkflowRepository({ db: db.db });
  const service = new WorkflowService({
    repo,
    db: db.db,
    workspaceDir,
    runners,
    now: () => nowRef.value,
    ...(opts.randomUUID !== undefined ? { randomUUID: opts.randomUUID } : {}),
    ...(opts.logger !== undefined
      ? { logger: opts.logger }
      : { logger: pino({ level: "silent" }) }),
  });
  return {
    service,
    repo,
    coordRunner,
    workerRunner,
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
