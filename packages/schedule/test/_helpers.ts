import type { Logger } from "pino";
import pino from "pino";
import { ScheduleRepository } from "../src/schedule-repository.js";
import { ScheduleService } from "../src/schedule-service.js";
import { openTestScheduleDb } from "../src/testing.js";
import type { ScheduleKindHandler } from "../src/types.js";

/**
 * A spy-able implementation of {@link ScheduleKindHandler} for use
 * in schedule pkg tests.
 *
 * Default behaviour is intentionally permissive so tests that don't
 * care about a specific surface still get a sensible response:
 *   - `validate` is identity (whatever data is passed comes back
 *     unchanged); tests that want to assert rejection can swap the
 *     fn at runtime.
 *   - `mergePatch` is a shallow `{ ...existing, ...patch }` and the
 *     `changedKeys` are the patch's top-level keys (mirrors RFC
 *     7396 for flat objects, which is what most kinds end up
 *     storing). Tests that want richer merge semantics (`null`
 *     deletes etc.) override.
 *   - `dispatch` returns `id: "dispatch-1"`, then `"dispatch-2"`,
 *     etc. on each call so test assertions can pin the exact id.
 *   - `hasInFlightForSchedule` reads from `inFlightSet`.
 *   - `deleteForSchedule` returns whatever's in `deleteReturns` (or
 *     `{ deletedCount: 0 }` by default) and records the call.
 *
 * Test code can mutate the fields on the returned handle to drive
 * the stub's behaviour (e.g. `h.validate = vi.fn(...)` to assert
 * call args).
 */
export interface DispatchCall {
  readonly scheduleId: string;
  readonly firedAt: string;
  readonly data: unknown;
}

export interface StubHandler extends ScheduleKindHandler {
  /** Recorded invocations of `dispatch`, in call order. */
  readonly dispatchCalls: DispatchCall[];
  /** Recorded invocations of `validate`, in call order. */
  readonly validateCalls: Array<{ data: unknown; changedKeys?: readonly string[] }>;
  /** Recorded invocations of `mergePatch`, in call order. */
  readonly mergePatchCalls: Array<{ existing: unknown; patch: unknown }>;
  /** Schedules considered to have in-flight dispatches. */
  readonly inFlightSet: Set<string>;
  /** Recorded invocations of `deleteForSchedule`, in call order. */
  readonly deleteCalls: string[];
  /** Map of scheduleId → next-call return value for `deleteForSchedule`. */
  readonly deleteReturns: Map<string, { deletedCount: number }>;
  /** Next id to return from `dispatch`. Auto-bumped via a sequence by default. */
  nextDispatchId: string;
}

export function makeStubHandler(): StubHandler {
  const dispatchCalls: DispatchCall[] = [];
  const validateCalls: Array<{ data: unknown; changedKeys?: readonly string[] }> = [];
  const mergePatchCalls: Array<{ existing: unknown; patch: unknown }> = [];
  const inFlightSet = new Set<string>();
  const deleteCalls: string[] = [];
  const deleteReturns = new Map<string, { deletedCount: number }>();
  let seq = 0;
  let overrideNextDispatchId: string | null = null;

  const stub: StubHandler = {
    dispatchCalls,
    validateCalls,
    mergePatchCalls,
    inFlightSet,
    deleteCalls,
    deleteReturns,
    get nextDispatchId() {
      return overrideNextDispatchId ?? `dispatch-${seq + 1}`;
    },
    set nextDispatchId(v: string) {
      overrideNextDispatchId = v;
    },
    async validate(data, opts) {
      validateCalls.push({
        data,
        ...(opts?.changedKeys !== undefined ? { changedKeys: opts.changedKeys } : {}),
      });
      return data;
    },
    mergePatch(existing, patch) {
      mergePatchCalls.push({ existing, patch });
      const e = (existing ?? {}) as Record<string, unknown>;
      const p = (patch ?? {}) as Record<string, unknown>;
      return {
        data: { ...e, ...p },
        changedKeys: Object.keys(p),
      };
    },
    async dispatch(opts) {
      dispatchCalls.push(opts);
      seq += 1;
      const id = overrideNextDispatchId ?? `dispatch-${seq}`;
      overrideNextDispatchId = null;
      return { id };
    },
    async hasInFlightForSchedule(id) {
      return inFlightSet.has(id);
    },
    async deleteForSchedule(id) {
      deleteCalls.push(id);
      return deleteReturns.get(id) ?? { deletedCount: 0 };
    },
  };
  return stub;
}

export interface ScheduleTestHandle {
  readonly service: ScheduleService;
  readonly repo: ScheduleRepository;
  /** The stub handler auto-registered for kind `"task"`. */
  readonly taskHandler: StubHandler;
  readonly nowRef: { value: Date };
  readonly db: ReturnType<typeof openTestScheduleDb>;
  /** Bump the injected clock without mutating the original Date instance. */
  setNow(d: Date): void;
  close(): void;
}

/**
 * Compose a `ScheduleService` over an in-memory SQLite + a stub
 * handler auto-registered for kind `"task"`. The default keeps
 * existing test call sites short — most tests assert on the
 * substrate (timer chain / recover / repo round-trip) and don't
 * care which kind they use, so we use `"task"` as the conventional
 * placeholder.
 *
 * `recover()` is NOT called automatically — tests that need it
 * (the recover suite) invoke it explicitly so they can register
 * additional kinds first (see `schedule-service.registry.test.ts`).
 *
 * The returned handle exposes both the service and the stub
 * handler so assertions can pin call args (`h.taskHandler.dispatchCalls[0]`).
 */
export function makeScheduleTestHandle(
  opts: {
    readonly initialNow?: Date;
    readonly randomUUID?: () => string;
    readonly logger?: Logger;
    readonly taskHandler?: StubHandler;
    /**
     * When true, skip auto-registering the `"task"` kind. Tests that
     * want to exercise the empty-registry surface set this.
     */
    readonly skipRegisterTask?: boolean;
  } = {},
): ScheduleTestHandle {
  const db = openTestScheduleDb();
  const taskHandler = opts.taskHandler ?? makeStubHandler();
  const nowRef = { value: opts.initialNow ?? new Date("2026-05-01T00:00:00.000Z") };
  const repo = new ScheduleRepository({ db: db.db });
  const service = new ScheduleService({
    repo,
    now: () => nowRef.value,
    ...(opts.randomUUID !== undefined ? { randomUUID: opts.randomUUID } : {}),
    ...(opts.logger !== undefined
      ? { logger: opts.logger }
      : { logger: pino({ level: "silent" }) }),
  });
  if (opts.skipRegisterTask !== true) {
    service.registerKind("task", taskHandler);
  }
  return {
    service,
    repo,
    taskHandler,
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
