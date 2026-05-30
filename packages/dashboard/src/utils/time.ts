/**
 * Time formatting helpers shared across pages. Hoisted out of
 * Sessions / App so the same "4m ago" / "2d ago" idiom is used
 * everywhere — list tables, detail panels, landing page recents,
 * tooltip hovers — without each page re-rolling its own thresholds.
 */

/**
 * Compact relative time string, e.g. `"just now"`, `"4m ago"`,
 * `"3h ago"`, `"2d ago"` for past timestamps, and `"in 4m"`,
 * `"in 3h"`, `"in 2d"` for future ones (next-fire previews, etc).
 * After 30 days falls back to a locale date string (the "this
 * happened a long time ago, exact date matters more than how-long-
 * ago" cutoff). Returns `"—"` for unparseable input, matching the
 * dashboard's "missing field" placeholder.
 */
export function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (Math.abs(diff) < 5_000) return "just now";
  const past = diff > 0;
  const abs = Math.abs(diff);
  const sec = Math.round(abs / 1000);
  if (sec < 60) return past ? `${sec}s ago` : `in ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return past ? `${min}m ago` : `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return past ? `${hr}h ago` : `in ${hr}h`;
  const d = Math.round(hr / 24);
  if (d < 30) return past ? `${d}d ago` : `in ${d}d`;
  return new Date(t).toLocaleDateString();
}

/**
 * Locale-formatted absolute timestamp, e.g. `"5/11/2026, 12:34:56 PM"`.
 * Used for the `title=` tooltip on relative-time labels so users can
 * recover the exact instant when needed.
 */
export function formatAbsolute(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}

/**
 * Human-readable duration between two ISO timestamps (or a started
 * time + `null` end = "running, elapsed up to now"). Output is the
 * largest two units, e.g. `"1h 23m"`, `"4m 15s"`, `"22s"`. Negative
 * durations clamp to `"0s"` so a clock skew doesn't surface as
 * `"−2s"`.
 */
export function formatDuration(startIso: string, endIso: string | null): string {
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return "—";
  const end = endIso === null ? Date.now() : Date.parse(endIso);
  if (Number.isNaN(end)) return "—";
  const diff = Math.max(0, end - start);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}
