import { useEffect, useRef } from "react";

/**
 * Run `poll` on a timer with **exponential backoff on failure** and
 * automatic reset on success.
 *
 * Why this exists: the dashboard's task list and detail panel both poll
 * while any task is `running`. With a plain `setInterval`, when the
 * server goes down (laptop sleep, restart, crash) the dashboard keeps
 * firing requests at the configured cadence forever — every 4s a fresh
 * `ECONNREFUSED` racks up in the console, the network panel fills with
 * red, and once the server comes back the recovery is fine but the
 * preceding minutes were wasted noise.
 *
 * This hook chains polls via `setTimeout` instead, so we never have two
 * polls in flight at once, and on each rejection it doubles the wait
 * (capped at `maxIntervalMs`). On the next successful poll it snaps
 * back to `intervalMs`.
 *
 * Behaviour summary:
 *   - If `enabled` is false, no polling. Re-enabling triggers a poll
 *     after `intervalMs` (not immediate — leaves the initial fetch to
 *     the parent's own load effect).
 *   - On success, the next delay is `intervalMs`.
 *   - On failure, the next delay is `min(currentDelay * 2, maxIntervalMs)`.
 *   - Resets backoff to baseline whenever `enabled` flips false then
 *     true (so toggling pages doesn't carry old penalty over).
 *   - Uses a ref-based latest-callback pattern so callers can pass a
 *     fresh `poll` closure every render without restarting the timer.
 *
 * @param poll          Async function whose rejection counts as failure.
 *                      A throw or rejected promise both trigger backoff.
 * @param intervalMs    Baseline cadence. Caller usually sources this
 *                      from `/api/config` (`config.tasks.pollIntervalMs`).
 * @param enabled       When false, the hook does nothing. Lets callers
 *                      stop polling once every task is terminal.
 * @param maxIntervalMs Upper bound on backed-off delay. Defaults to 60s
 *                      — long enough that a sleeping laptop doesn't
 *                      flood the server on wake, short enough that a
 *                      restarted server is noticed within a minute.
 */
export function usePollWithBackoff(
  poll: () => Promise<unknown>,
  intervalMs: number,
  enabled: boolean,
  maxIntervalMs = 60_000,
): void {
  // Latest-callback ref so we don't restart the timer chain on every
  // re-render of the parent (which would happen if `poll` were in the
  // effect deps directly).
  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let currentDelay = intervalMs;

    const schedule = (delayMs: number) => {
      if (cancelled) return;
      timer = setTimeout(async () => {
        if (cancelled) return;
        try {
          await pollRef.current();
          if (cancelled) return;
          currentDelay = intervalMs;
        } catch {
          if (cancelled) return;
          currentDelay = Math.min(maxIntervalMs, Math.max(intervalMs, currentDelay * 2));
        }
        schedule(currentDelay);
      }, delayMs);
    };

    // First scheduled poll happens after `intervalMs` (not immediate);
    // the parent's own load effect handles the initial fetch.
    schedule(intervalMs);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled, intervalMs, maxIntervalMs]);
}
