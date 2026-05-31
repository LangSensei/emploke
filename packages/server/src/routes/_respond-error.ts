import type { Context } from "hono";
import { errorBody, logFault, unmappedFaultMeta } from "./_shared.js";

/**
 * One entry on an {@link ErrorPolicy}: an error class, the HTTP status
 * it maps to, and an optional class-stable body builder.
 *
 * Use the third slot ONLY for envelopes whose shape depends on the
 * error instance alone — not on the route. Example: `EntryNotReadyError`
 * always returns `{ error, code, agent, reason }` regardless of which
 * route caught it, so its body builder lives on the policy entry.
 *
 * Counter-example: `InvalidTransition` returns
 * `{ error, code, status, transition }` where `transition` is `"cancel"`
 * on `tasks.cancel` and `"delete"` on `tasks.delete`. That body is
 * route-dependent — pass it via `RespondErrorOpts.customBody`, not here.
 */
export type StatusEntry = readonly [
  klass: new (...args: never[]) => Error,
  status: number,
  classStableBody?: (err: Error) => Record<string, unknown>,
];

/**
 * A per-domain error policy — ordered list of `(class, status, body?)`
 * triples plus an optional default status. Each domain (tasks /
 * schedules / sessions / workspaces / catalog) maintains its own
 * policy so name-equal classes from different packages (e.g. the four
 * different `AgentNotFoundError` classes) map independently.
 */
export interface ErrorPolicy {
  readonly name: string;
  readonly statuses: ReadonlyArray<StatusEntry>;
  /**
   * Status used when no `statuses` entry matches the thrown error.
   * Defaults to 400. Some routes (read-only / server-failure paths)
   * override per-call via `RespondErrorOpts.defaultStatus`.
   */
  readonly defaultStatus?: number;
}

export interface RespondErrorOpts {
  /**
   * Route label that lands on the structured log line, e.g.
   * `"tasks.cancel"` / `"sessions.create"`. Used as the message prefix
   * for both the "5xx fault" and "unmapped error fell through" log
   * entries so operators can grep by route.
   */
  readonly route: string;
  readonly policy: ErrorPolicy;
  /**
   * Extra meta fields to attach to the structured log line
   * (`taskId`, `sessionId`, etc.). Forwarded verbatim to
   * {@link logFault}; included in `unmappedFaultMeta` when the error
   * class is unmapped.
   */
  readonly meta?: Record<string, unknown>;
  /**
   * Per-call body builder that takes precedence over both the matched
   * entry's class-stable body and the default `errorBody`. Used for
   * route-dependent envelopes (e.g. `InvalidTransition` with verb).
   * Return `null` to fall back to the class-stable / default body.
   */
  readonly customBody?: (err: unknown, status: number) => Record<string, unknown> | null;
  /**
   * Per-call override of `policy.defaultStatus`. Used by workspace
   * read paths whose pre-refactor `wsErrorJson(c, err, 500)` baked the
   * fallback status into each call site instead of into the policy.
   * Mapped-class status (from `policy.statuses`) always wins; this
   * only changes the fallthrough.
   */
  readonly defaultStatus?: number;
}

/**
 * Centralised catch-block body for every route in
 * `packages/server/src/routes/**`. Resolves status via the per-domain
 * `ErrorPolicy`, emits the structured "5xx fault" or "unmapped error
 * fell through" log line via {@link logFault}, and returns the JSON
 * response with the consolidated `as any` cast on the status.
 *
 * Status resolution:
 *   - First `instanceof` match in `policy.statuses` wins (order is
 *     significant — list subclasses before their bases).
 *   - On no match: status falls back to
 *     `opts.defaultStatus ?? policy.defaultStatus ?? 400`, and the
 *     entry is flagged `isUnmapped` so the log path fires.
 *
 * Body precedence:
 *   1. `opts.customBody(err, status)` when defined AND returns non-null
 *   2. The matched entry's `classStableBody(err)` if present
 *   3. {@link errorBody} fallback (collapses unrecognised classes to
 *      `{ error: "internal error" }` per `SAFE_ERROR_NAMES`)
 */
export function respondError(c: Context, err: unknown, opts: RespondErrorOpts): Response {
  let status: number | undefined;
  let classStableBody: ((err: Error) => Record<string, unknown>) | undefined;

  if (err instanceof Error) {
    for (const entry of opts.policy.statuses) {
      const [klass, entryStatus, bodyBuilder] = entry;
      if (err instanceof klass) {
        status = entryStatus;
        classStableBody = bodyBuilder;
        break;
      }
    }
  }

  const isUnmapped = status === undefined;
  const finalStatus = status ?? opts.defaultStatus ?? opts.policy.defaultStatus ?? 400;

  if (finalStatus >= 500) {
    logFault(c, err, `${opts.route}: 5xx fault`, opts.meta);
  } else if (isUnmapped) {
    logFault(
      c,
      err,
      `${opts.route}: unmapped error fell through to ${finalStatus}`,
      unmappedFaultMeta(err, opts.meta),
    );
  }

  let body: Record<string, unknown>;
  const fromCustom = opts.customBody?.(err, finalStatus);
  if (fromCustom !== undefined && fromCustom !== null) {
    body = fromCustom;
  } else if (classStableBody !== undefined && err instanceof Error) {
    body = classStableBody(err);
  } else {
    body = errorBody(err);
  }

  // biome-ignore lint/suspicious/noExplicitAny: Hono's c.json status type is a finite union — consolidates the per-route casts that used to scatter across routes/**.
  return c.json(body, finalStatus as any);
}
