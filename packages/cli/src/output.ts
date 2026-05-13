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
 * For an {@link ApiError} the message includes:
 *  - the server's `error` field
 *  - the optional `code` field (so users can tell `WorkspaceNotFoundError`
 *    apart from `BadRequest` apart from `EntryNotReadyError` without
 *    parsing the prose)
 *  - `EntryNotReadyError`-specific structured hints (the agent FQN and
 *    the {@link BlockedReason} bullet list, plus a CTA pointing at the
 *    matching `emploke catalog ...` subcommand)
 *
 * Anything else (network error, generic `Error`, thrown string) falls
 * through to a plain `<message>\n`. Output stays line-oriented either
 * way — every emitted line ends in `\n`.
 */
export function formatError(err: unknown): CommandResult {
  if (err instanceof ApiError) {
    const lines: string[] = [];
    const code = pickStringField(err.body, "code");
    const headline = code
      ? `${err.message} (HTTP ${err.status}, ${code})`
      : `${err.message} (HTTP ${err.status})`;
    lines.push(headline);
    if (code === "EntryNotReadyError") {
      lines.push(...formatEntryNotReadyHint(err.body));
    }
    return { exitCode: 4, stderr: `${lines.join("\n")}\n` };
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
 * Read a string-typed field off a parsed JSON error body. Defensive
 * because `body` is typed `unknown` — the server contract says it's
 * `{error, code?, ...}` but we don't want a malformed reply to throw
 * inside an error formatter.
 */
function pickStringField(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Render the `EntryNotReadyError` envelope extension shipped by
 * `POST /api/workspaces/:id/tasks` (see
 * `packages/server/src/routes/tasks.ts`). Mirrors the dashboard's
 * structured CTA — every actionable cause gets a one-liner pointing
 * the user at the matching CLI subcommand so the terminal experience
 * matches the web UI.
 */
function formatEntryNotReadyHint(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const obj = body as Record<string, unknown>;
  const lines: string[] = [];
  const agent = typeof obj.agent === "string" ? obj.agent : undefined;
  if (agent) lines.push(`  agent: ${agent}`);
  const reason = obj.reason;
  if (typeof reason !== "object" || reason === null) return lines;
  // Snapshot line count BEFORE the reason-specific branches so we can
  // detect "reason was an object but none of our known fields matched"
  // — that means the server has likely added a new BlockedReason
  // field this CLI version doesn't know about. Falling back to a
  // generic pointer is better than emitting just the agent line and
  // leaving the user staring at a bare HTTP 409.
  const linesBeforeReason = lines.length;
  const r = reason as {
    needsPrereqsAck?: unknown;
    disabledByUser?: unknown;
    orphaned?: unknown;
    missingDeps?: unknown;
    blockedDeps?: unknown;
  };
  if (r.disabledByUser === true) {
    lines.push("  cause: agent is disabled");
    if (agent) lines.push(`  fix:   emploke catalog agent enable ${agent}`);
  }
  if (r.needsPrereqsAck === true) {
    lines.push("  cause: prereqs not acknowledged");
    if (agent) lines.push(`  fix:   emploke catalog agent ack-prereqs ${agent}`);
  }
  if (r.orphaned === true) {
    lines.push("  cause: orphaned (no installed entry references this)");
  }
  if (Array.isArray(r.missingDeps) && r.missingDeps.length > 0) {
    const refs = r.missingDeps
      .map((d) => (typeof d === "object" && d !== null ? formatDepRef(d) : ""))
      .filter((s) => s !== "");
    if (refs.length > 0) {
      lines.push(`  cause: missing dependencies (${refs.length})`);
      for (const ref of refs) lines.push(`    - ${ref}`);
      lines.push("  fix:   install the missing dependencies, then retry");
    }
  }
  if (Array.isArray(r.blockedDeps) && r.blockedDeps.length > 0) {
    const refs = r.blockedDeps
      .map((d) => (typeof d === "object" && d !== null ? formatDepRef(d) : ""))
      .filter((s) => s !== "");
    if (refs.length > 0) {
      lines.push(`  cause: blocked dependencies (${refs.length})`);
      for (const ref of refs) lines.push(`    - ${ref}`);
      lines.push("  fix:   resolve the blocked dependencies, then retry");
    }
  }
  if (lines.length === linesBeforeReason) {
    // Reason payload had no recognized field. Either the server added
    // a new BlockedReason variant after this CLI was built, or the
    // payload is malformed. Surface a generic pointer rather than
    // staying silent.
    lines.push("  cause: blocked (reason fields not recognized by this CLI version)");
    lines.push("  fix:   inspect via the dashboard or upgrade the CLI for typed remediation");
  }
  return lines;
}

function formatDepRef(d: object): string {
  const o = d as { kind?: unknown; fqn?: unknown };
  const kind = typeof o.kind === "string" ? o.kind : "?";
  const fqn = typeof o.fqn === "string" ? o.fqn : "";
  return fqn ? `${kind}: ${fqn}` : kind;
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
