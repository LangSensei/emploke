import { Writable } from "node:stream";
import pino, { type Level, type Logger } from "pino";

/**
 * Test-only helpers for the logging surface. Re-exported under
 * `pino (was @emploke/logger; pkg folded into consumers)/testing` so production bundles don't pick them up.
 */

/**
 * One captured log entry. Field shape matches pino's JSON output:
 *
 *   {
 *     level: 30,           // pino numeric level (10/20/30/40/50/60)
 *     time:  1715000000000,
 *     msg:   "user logged in",
 *     ...spread of meta passed at the call site
 *   }
 *
 * Tests typically filter by `level` (numeric) and assert on `msg` plus
 * the meta fields they care about.
 */
export interface CapturedLogEntry {
  level: number;
  time?: number;
  msg?: string;
  [key: string]: unknown;
}

/** Numeric → string mapping for pino levels, useful in test assertions. */
export const PINO_LEVEL: Readonly<Record<number, Level>> = Object.freeze({
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
});

/**
 * Build a `Logger` plus a backing `entries` array that captures every
 * log line as a parsed JSON object. Use in unit tests that need to
 * assert log output:
 *
 *   const { logger, entries } = captureLogger();
 *   serviceUnderTest({ logger });
 *   expect(entries.find((e) => e.msg === "expected msg")).toBeDefined();
 *
 * `level` defaults to `"trace"` so every call site is captured; pass a
 * higher level if a test wants to assert that lower-level lines are
 * filtered.
 */
export function captureLogger(opts: { level?: Level } = {}): {
  readonly logger: Logger;
  readonly entries: CapturedLogEntry[];
} {
  const entries: CapturedLogEntry[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // pino emits one JSON object per line, terminated by \n. Multiple
      // lines may arrive in one chunk under high write rates.
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        try {
          entries.push(JSON.parse(line) as CapturedLogEntry);
        } catch {
          // Non-JSON output (shouldn't happen with the default formatter)
          // is dropped; tests assert on parsed entries only.
        }
      }
      cb();
    },
  });
  const logger = pino(
    {
      level: opts.level ?? "trace",
      serializers: { err: pino.stdSerializers.err },
    },
    stream,
  );
  return { logger, entries };
}
