/**
 * Server-clock-anchored "now" for the dashboard.
 *
 * Every preset filter ("Today", "7d", "30d") computes a cutoff and ships
 * it to the server as `?createdSince=<iso>`. The server compares it
 * lexicographically against `task.createdAt` / `session.createdAt`,
 * which were stamped by the **server's** clock at write time.
 *
 * If the dashboard uses raw `Date.now()` and the user's laptop clock has
 * drifted (NTP off, manual time change, sleep-resume skew, phone-on-LAN
 * different timezone), the cutoff straddles entries the user expected
 * to see — silently. "Today" can hide today's tasks. "7d" can include
 * older rows or miss newer ones.
 *
 * This module syncs the offset between client and server clocks via
 * `/api/health` (which echoes its own `serverNow`) once at boot and
 * refreshes periodically. Callers compute presets against `serverNow()`
 * — local clock plus the cached offset — so cutoffs match what the
 * server actually sees, regardless of the user's local clock state.
 *
 * Single-instance, module-level state. Not React-reactive: filter
 * presets are evaluated at click time, so the latest cached offset is
 * applied without needing a re-render of consumers.
 */

import { getHealth } from "./api";

/** Cached offset: `clientNow + offsetMs ≈ serverNow` (ms). */
let offsetMs = 0;

/** When did we last successfully sync? `null` if never. */
let lastSyncAtMs: number | null = null;

/** Optional in-flight handle so we don't issue overlapping syncs. */
let inflight: Promise<void> | null = null;

/**
 * Clock-skew estimate at the time of the last successful sync. Useful
 * for diagnostics / tests but not exported through the main `serverNow`
 * path so consumers can't accidentally branch on it.
 */
export function debugClockState(): { offsetMs: number; lastSyncAtMs: number | null } {
  return { offsetMs, lastSyncAtMs };
}

/**
 * Approximate the server's current wall clock as a `Date` value.
 *
 * Returns `new Date(Date.now() + offsetMs)`. Before the first sync
 * succeeds, `offsetMs` is 0 and this falls back to local clock — same
 * behaviour as before this module existed, so degradation on
 * sync-failure is graceful.
 */
export function serverNow(): Date {
  return new Date(Date.now() + offsetMs);
}

/**
 * Fire a one-shot `/api/health` round trip and update the cached offset.
 *
 * `offsetMs = serverNow - clientNowAtFetch`. To dampen request-latency
 * bias we use the midpoint between request-start and response-arrival
 * as the client-side anchor; this gives ~RTT/2 accuracy without needing
 * NTP-style multi-sample math (overkill for a UI cutoff).
 *
 * Failures (server down, fetch reject) leave the cached offset
 * unchanged — the dashboard's poll-with-backoff loop will eventually
 * recover, and in the meantime cutoffs use the last good offset (or 0
 * if we never had one). Concurrent calls are deduped via `inflight`.
 */
export async function syncServerClock(): Promise<void> {
  if (inflight) return inflight;
  const startMs = Date.now();
  inflight = (async () => {
    try {
      const health = await getHealth();
      const responseArrivedMs = Date.now();
      const midpointMs = (startMs + responseArrivedMs) / 2;
      const serverMs = Date.parse(health.serverNow);
      if (Number.isFinite(serverMs)) {
        offsetMs = serverMs - midpointMs;
        lastSyncAtMs = responseArrivedMs;
      }
    } catch {
      // Leave previous offset in place. The next backoff cycle will retry.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Periodic resync helper. Call once at app boot. Returns a teardown
 * that clears the interval — wire it into a React effect cleanup if you
 * need it bounded to a component lifetime, or call it once at app boot
 * and never tear down (single-instance app).
 *
 * Default cadence is 5 minutes. Sized to absorb laptop sleep-resume
 * (which typically only skews the clock by ms, not minutes) without
 * spending bandwidth on a problem that's rare. Operators with hostile
 * clock environments can shorten it; tests can pin it to milliseconds.
 */
export function startClockSync(periodMs = 5 * 60 * 1000): () => void {
  void syncServerClock();
  const handle = setInterval(() => {
    void syncServerClock();
  }, periodMs);
  return () => clearInterval(handle);
}

/** Test-only seam: reset the cached state. */
export function __resetServerClockForTests(): void {
  offsetMs = 0;
  lastSyncAtMs = null;
  inflight = null;
}
