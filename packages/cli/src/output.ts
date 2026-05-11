/**
 * Output formatting helpers shared by every API-mapping command.
 *
 * Three layers:
 *  - `formatJson` — `JSON.stringify(value, null, 2)` + trailing newline.
 *    Used everywhere `--output json` is requested.
 *  - `formatTable` — small fixed-width table renderer for list outputs.
 *  - `formatRecord` — key/value layout for `show`-style outputs.
 *  - `formatApiError` — turn an {@link ApiError} into the standard
 *    `CommandResult.stderr` + exit-code mapping documented in
 *    `result.ts`.
 *
 * The table renderer is intentionally minimal — no colour, no
 * truncation, no auto-resize. CLI output goes through pipes more often
 * than terminals, so deterministic columns beat fancy formatting.
 */

import { ApiError } from "./api-client.js";
import type { CommandResult } from "./result.js";

export type OutputFormat = "table" | "json";

/**
 * Render a JSON payload with stable indentation and trailing newline.
 * Same shape every CLI command emits when `--output json` is set.
 */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Render a list as a simple ASCII table. Headers are uppercased and
 * separated from rows by a blank line so the output stays grep-able
 * (every row has the same column count). When `rows` is empty, returns
 * just the header line so scripts can still detect "0 results".
 */
export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const allRows = [headers.map((h) => h.toUpperCase()), ...rows];
  const widths = headers.map((_, col) =>
    allRows.reduce((max, r) => Math.max(max, (r[col] ?? "").length), 0),
  );
  const lines = allRows.map((r) =>
    r
      .map((cell, col) => (cell ?? "").padEnd(widths[col] ?? 0))
      .join("  ")
      .trimEnd(),
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Render a single record as a `KEY  VALUE` block. Used for `show`-style
 * outputs where one entity's fields fit better stacked than tabled.
 */
export function formatRecord(record: Record<string, unknown>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return "(empty)\n";
  const labelWidth = entries.reduce((max, [k]) => Math.max(max, k.length), 0);
  const lines = entries.map(([k, v]) => {
    const label = k.toUpperCase().padEnd(labelWidth);
    const value =
      v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return `${label}  ${value}`;
  });
  return `${lines.join("\n")}\n`;
}

/**
 * Convert any thrown error into a structured {@link CommandResult}.
 *
 * Exit codes:
 *  - 3 — server unreachable (network error, ECONNREFUSED, …)
 *  - 4 — server returned a 4xx/5xx (anything `ApiError`)
 *  - 1 — generic / unknown
 *
 * The stderr message tries to be operator-friendly: an `ApiError`
 * surfaces the server's `error` field; a network error surfaces the
 * underlying message. Either way `\n` is appended so output stays
 * line-oriented.
 */
export function formatError(err: unknown): CommandResult {
  if (err instanceof ApiError) {
    return {
      exitCode: 4,
      stderr: `${err.message} (HTTP ${err.status})\n`,
    };
  }
  // fetch's TypeError("fetch failed") with cause.code = "ECONNREFUSED"
  // — this is the canonical "server isn't running" signal.
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    const cause = (err as Error & { cause?: unknown }).cause;
    const reason = cause instanceof Error ? cause.message : err.message;
    return { exitCode: 3, stderr: `server unreachable: ${reason}\n` };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { exitCode: 1, stderr: `${message}\n` };
}

/**
 * Pick `table` or `json` based on the user's `--output` / `--json`
 * flags. Defaults to the caller-supplied `defaultFormat` so list
 * commands can default to `"table"` and show commands to `"json"`
 * without re-implementing the precedence logic at every site.
 */
export function pickFormat(
  flags: { readonly output?: string; readonly json?: boolean } | undefined,
  defaultFormat: OutputFormat,
): OutputFormat {
  if (flags?.json === true) return "json";
  if (flags?.output === "json") return "json";
  if (flags?.output === "table") return "table";
  return defaultFormat;
}
