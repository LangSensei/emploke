/**
 * @emploke/logger — structured-logging surface used by every server-side
 * package.
 *
 * Backed by [pino](https://github.com/pinojs/pino) under the hood for
 * three reasons:
 *
 * 1. **Async file writes** in a worker thread, so logging never blocks
 *    the HTTP event loop.
 * 2. **Structured (JSON) output** in production, so operators can grep,
 *    `jq`, or pipe into a log aggregator without parsing prose.
 * 3. **Pretty pretty-printing** in development via `pino-pretty`, so
 *    `pnpm dev` stays human-readable.
 *
 * Persistence: when `dir` is supplied (server boot does this; tests
 * usually don't), pino-roll writes daily-rotated files to that
 * directory under `<basename>-YYYY-MM-DD.log` with a configurable size
 * cap and retention count. **No log lines are lost on rotation** —
 * pino-roll closes the previous file only after opening the new one.
 *
 * The public `Logger` interface is the smallest cross-package contract.
 * It deliberately does NOT expose pino-specific methods (child loggers,
 * serializers, level configuration at runtime) so we can swap to a
 * different backend later without touching ~20 call sites.
 *
 * Test seam: `silentLogger` drops every call. Use it in unit tests that
 * don't care about logging — every manager that accepts a `logger`
 * defaults to it when none is supplied.
 */

export {
  type BuildLoggerOpts,
  buildLogger,
  type Logger,
  type LogLevel,
  silentLogger,
} from "./logger.js";
