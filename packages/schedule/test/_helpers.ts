import type { Logger } from "pino";
import pino from "pino";
import { ScheduleRepository } from "../src/schedule-repository.js";
import { ScheduleService } from "../src/schedule-service.js";
import { openTestScheduleDb } from "../src/testing.js";
import type { TaskDispatcher } from "../src/types.js";

export interface DispatchCall {
  readonly agent: string;
  readonly brief: string;
  readonly details?: string;
  readonly runtime?: string;
  readonly origin: "schedule";
  readonly metadata: { readonly scheduleId: string; readonly firedAt: string };
}

export interface StubDispatcher extends TaskDispatcher {
  readonly calls: DispatchCall[];
  inFlightSet: Set<string>;
  nextTaskId: string;
  /** Map of scheduleId → next-call return value. Defaults to `{ deletedCount: 0 }`. */
  deleteForScheduleReturns: Map<string, { deletedCount: number }>;
  /** Records of every `deleteForSchedule` invocation in order. */
  readonly deleteForScheduleCalls: string[];
}

export function makeStubDispatcher(): StubDispatcher {
  const calls: DispatchCall[] = [];
  const inFlightSet = new Set<string>();
  const deleteForScheduleReturns = new Map<string, { deletedCount: number }>();
  const deleteForScheduleCalls: string[] = [];
  let nextTaskId = "task-1";
  const stub: StubDispatcher = {
    calls,
    inFlightSet,
    deleteForScheduleReturns,
    deleteForScheduleCalls,
    get nextTaskId() {
      return nextTaskId;
    },
    set nextTaskId(v: string) {
      nextTaskId = v;
    },
    async dispatch(opts) {
      calls.push(opts);
      return { id: nextTaskId };
    },
    async hasInFlightForSchedule(id) {
      return inFlightSet.has(id);
    },
    async deleteForSchedule(id) {
      deleteForScheduleCalls.push(id);
      return deleteForScheduleReturns.get(id) ?? { deletedCount: 0 };
    },
  };
  return stub;
}

/** Always-accepting agent validator stub. */
export const acceptAgent = async (_fqn: string): Promise<void> => {
  void _fqn;
};

/** Rejecting agent validator (used in negative tests). */
export const rejectAgent = async (fqn: string): Promise<void> => {
  throw new Error(`stub: agent "${fqn}" not found`);
};

export interface ScheduleTestHandle {
  readonly service: ScheduleService;
  readonly repo: ScheduleRepository;
  readonly dispatcher: StubDispatcher;
  readonly nowRef: { value: Date };
  readonly db: ReturnType<typeof openTestScheduleDb>;
  /** Bump the injected clock without mutating the original Date instance. */
  setNow(d: Date): void;
  close(): void;
}

export function makeScheduleTestHandle(
  opts: {
    readonly initialNow?: Date;
    readonly agentValidator?: (fqn: string) => Promise<void>;
    readonly randomUUID?: () => string;
    readonly logger?: Logger;
    readonly dispatcher?: StubDispatcher;
  } = {},
): ScheduleTestHandle {
  const db = openTestScheduleDb();
  const dispatcher = opts.dispatcher ?? makeStubDispatcher();
  const nowRef = { value: opts.initialNow ?? new Date("2026-05-01T00:00:00.000Z") };
  const repo = new ScheduleRepository({ db: db.db });
  const service = new ScheduleService({
    repo,
    taskDispatcher: dispatcher,
    agentValidator: opts.agentValidator ?? acceptAgent,
    now: () => nowRef.value,
    ...(opts.randomUUID !== undefined ? { randomUUID: opts.randomUUID } : {}),
    ...(opts.logger !== undefined
      ? { logger: opts.logger }
      : { logger: pino({ level: "silent" }) }),
  });
  return {
    service,
    repo,
    dispatcher,
    nowRef,
    db,
    setNow(d) {
      nowRef.value = d;
    },
    close() {
      db.close();
    },
  };
}

export function fixedRandomUUID(ids: readonly string[]): () => string {
  let i = 0;
  return () => {
    const id = ids[i];
    if (id === undefined) throw new Error("fixedRandomUUID: out of ids");
    i++;
    return id;
  };
}

export const VALID_UUIDS = [
  "550e8400-e29b-41d4-a716-446655440000",
  "550e8400-e29b-41d4-a716-446655440001",
  "550e8400-e29b-41d4-a716-446655440002",
  "550e8400-e29b-41d4-a716-446655440003",
] as const;
