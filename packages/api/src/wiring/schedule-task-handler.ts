import type { CatalogService } from "@emploke/catalog";
import type { TaskTargetData, TaskTargetPatch } from "@emploke/contracts";
import type { ScheduleKindHandler } from "@emploke/schedule";
import { AgentNotFoundError, AgentResolutionFailedError, type TaskService } from "@emploke/task";

/**
 * Sole module knowing about all of `@emploke/schedule`,
 * `@emploke/task`, AND `@emploke/catalog`. This is the only edge in
 * the cross-pkg import graph where the three meet — the schedule pkg
 * stays kind-agnostic; the task pkg stays unaware of schedules' SQL;
 * and the catalog pkg is consumed only here for agent existence.
 *
 * Responsibilities (the kind-specific concerns the schedule pkg
 * deliberately doesn't carry, absorbed here):
 *
 *   - task-target shape validation
 *   - agent existence lookup
 *   - RFC 7396 deep-merge of task target patches
 *   - origin/metadata synthesis for `TaskService.dispatch`
 *   - lifecycle pass-through for `hasInFlightForSchedule` /
 *     `deleteForSchedule`
 *
 * `validate(_, { changedKeys })` skips the async catalog lookup when
 * `agent` is not in `changedKeys` — this preserves the patch-when-
 * catalog-down invariant: a sparse "edit only brief" patch must not
 * fail because the catalog is unhealthy.
 *
 * Agent errors are RAISED USING TASK-PKG'S CLASSES directly. The
 * schedule pkg no longer re-exports its own `AgentNotFoundError` /
 * `AgentResolutionFailedError`; the server's `schedulesErrorPolicy`
 * has a single row for each, covering both this handler's path AND
 * the `/run` task-dispatch path.
 */
export function makeTaskKindHandler(deps: {
  readonly tasks: TaskService;
  readonly catalog: CatalogService;
}): ScheduleKindHandler {
  return {
    async validate(raw, opts) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new TaskScheduleTargetError("Task target data must be an object");
      }
      const obj = raw as Record<string, unknown>;
      if (typeof obj.agent !== "string" || obj.agent.trim().length === 0) {
        throw new TaskScheduleTargetError("Task target requires non-empty agent");
      }
      if (typeof obj.brief !== "string" || obj.brief.trim().length === 0) {
        throw new TaskScheduleTargetError("Task target requires non-empty brief");
      }
      if (obj.brief.includes("\n") || obj.brief.includes("\r")) {
        throw new TaskScheduleTargetError(
          "Task target brief must be a single line (no newline characters); pass long content via details",
        );
      }
      if (obj.brief.trim().length > 200) {
        throw new TaskScheduleTargetError("Task target brief must be 200 characters or fewer");
      }
      if (obj.details !== undefined && typeof obj.details !== "string") {
        throw new TaskScheduleTargetError("Task target details, when set, must be a string");
      }
      if (
        obj.runtime !== undefined &&
        (typeof obj.runtime !== "string" || obj.runtime.trim().length === 0)
      ) {
        throw new TaskScheduleTargetError(
          "Task target runtime, when set, must be a non-empty string",
        );
      }

      // Catalog existence — skip if changedKeys excludes "agent".
      // changedKeys === undefined means "full validate" (the create
      // path); the patch path passes the exact set of changed keys
      // so a brief-only edit skips the catalog round-trip.
      const mustCheckAgent = opts?.changedKeys === undefined || opts.changedKeys.includes("agent");
      if (mustCheckAgent) {
        let found: Awaited<ReturnType<typeof deps.catalog.getAgent>>;
        try {
          found = await deps.catalog.getAgent(obj.agent as string);
        } catch (err) {
          throw new AgentResolutionFailedError(obj.agent as string, err);
        }
        if (found === null) throw new AgentNotFoundError(obj.agent as string);
      }

      const validated: TaskTargetData = {
        agent: obj.agent as string,
        brief: obj.brief as string,
        ...(obj.details !== undefined ? { details: obj.details as string } : {}),
        ...(obj.runtime !== undefined ? { runtime: obj.runtime as string } : {}),
      };
      return validated;
    },

    mergePatch(existing, patch) {
      // Pre-condition (per ScheduleKindHandler contract): `existing`
      // is a value our own `validate` produced, so direct cast is
      // safe. The `patch` is the route-validated TaskTargetPatch
      // (server's validateTaskTargetPatch enforced types before the
      // call); we still treat it defensively as readonly opaque
      // input.
      const e = existing as TaskTargetData;
      const p = patch as TaskTargetPatch;
      const changedKeys: string[] = [];

      let agent = e.agent;
      if (p.agent !== undefined) {
        changedKeys.push("agent");
        agent = p.agent;
      }
      let brief = e.brief;
      if (p.brief !== undefined) {
        changedKeys.push("brief");
        brief = p.brief;
      }

      let details: string | undefined;
      if (p.details === null) {
        if (e.details !== undefined) changedKeys.push("details");
        details = undefined;
      } else if (p.details !== undefined) {
        changedKeys.push("details");
        details = p.details;
      } else {
        details = e.details;
      }

      let runtime: string | undefined;
      if (p.runtime === null) {
        if (e.runtime !== undefined) changedKeys.push("runtime");
        runtime = undefined;
      } else if (p.runtime !== undefined) {
        changedKeys.push("runtime");
        runtime = p.runtime;
      } else {
        runtime = e.runtime;
      }

      const data: TaskTargetData = {
        agent,
        brief,
        ...(details !== undefined ? { details } : {}),
        ...(runtime !== undefined ? { runtime } : {}),
      };
      return { data, changedKeys };
    },

    async dispatch({ scheduleId, firedAt, data }) {
      const t = data as TaskTargetData;
      const result = await deps.tasks.dispatch({
        agent: t.agent,
        brief: t.brief,
        // `{ details: undefined }` is NOT equivalent to omitting the
        // key under exactOptionalPropertyTypes; conditional spread.
        ...(t.details !== undefined ? { details: t.details } : {}),
        ...(t.runtime !== undefined ? { runtime: t.runtime } : {}),
        origin: "schedule",
        metadata: { scheduleId, firedAt },
      });
      return { id: result.id };
    },

    hasInFlightForSchedule(scheduleId) {
      return deps.tasks.hasInFlightForSchedule(scheduleId);
    },

    deleteForSchedule(scheduleId) {
      return deps.tasks.deleteForSchedule(scheduleId);
    },
  };
}

/**
 * Wire-shape error for malformed task target data. Lives next to
 * the handler (rather than in `@emploke/schedule`) because the
 * schedule pkg is kind-agnostic. The schedules-route's error policy
 * needs a 400 row for this; we set `.name = "TaskScheduleTargetError"`
 * so the policy's instanceof match wires up cleanly.
 */
export class TaskScheduleTargetError extends Error {
  override readonly name = "TaskScheduleTargetError";
}
