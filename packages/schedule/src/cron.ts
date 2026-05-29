import { Cron } from "croner";
import cronstrue from "cronstrue/i18n.js";
import { InvalidCronExprError, InvalidTimezoneError } from "./errors.js";

const FIVE_FIELD_RE = /^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s*$/;

/**
 * Validate a 5-field cron expression + IANA timezone string. Used by
 * service.create / service.patch / service.preview. Throws
 * `InvalidCronExprError` or `InvalidTimezoneError` on bad input.
 *
 * v1 hard-rejects 6-field (sub-minute) cron — the RFC locks the
 * dialect to POSIX/Vixie/Kubernetes/GH Actions standard so users get
 * a predictable surface across editors. Future `trigger.kind='interval'`
 * can cover sub-minute when it lands.
 */
export function assertValidCronExpr(expr: string): void {
  if (typeof expr !== "string" || !FIVE_FIELD_RE.test(expr)) {
    throw new InvalidCronExprError(
      String(expr),
      "6-field cron not supported in v1; use 5-field POSIX form",
    );
  }
  try {
    // croner Cron() throws synchronously on malformed expressions
    new Cron(expr, { paused: true });
  } catch (err) {
    throw new InvalidCronExprError(expr, err instanceof Error ? err.message : String(err));
  }
}

export function assertValidTimezone(tz: string): void {
  try {
    // Intl.DateTimeFormat throws RangeError on unknown IANA tz
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new InvalidTimezoneError(tz);
  }
}

/**
 * Compute the next N fires from `after` for the given cron + tz. Used
 * by `ScheduleService.preview` (N=3) and `ScheduleService.armNext` (N=1).
 *
 * The cursor advances to each computed `next` before the next call —
 * cloning the same `after` for every iteration would otherwise return
 * N copies of the first fire.
 */
export function nextRuns(expr: string, tz: string, after: Date, n: number): string[] {
  const c = new Cron(expr, { timezone: tz, paused: true });
  const runs: string[] = [];
  let cursor = after;
  for (let i = 0; i < n; i++) {
    const next = c.nextRun(cursor);
    if (next === null) break;
    runs.push(next.toISOString());
    cursor = next;
  }
  return runs;
}

/**
 * English human-readable description for the `describe` field of
 * `PreviewResult`. The library default (English) is the right choice for
 * consumers that don't carry locale context (server JSON, CLI). When
 * full dashboard i18n lands, locale negotiation should happen at the
 * presentation layer — not be plumbed through this seam (see #224).
 */
export function describeCron(expr: string): string {
  return cronstrue.toString(expr, { locale: "en" });
}
