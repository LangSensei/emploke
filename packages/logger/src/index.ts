/**
 * @emploke/logger — pino, with emploke's default configuration.
 *
 * emploke commits to pino as the logging API across the whole codebase.
 * `Logger` is `pino.Logger` directly — no wrapper interface in front.
 * The previous 4-method facade hid pino features (child loggers,
 * redact, serializers) that the code actually wants to use, in
 * exchange for the ability to swap pino for a different backend; that
 * swap is hypothetical work that won't happen, while the friction
 * was concrete daily cost.
 *
 * This package provides:
 *
 * 1. `Logger` / `LogLevel` — re-exports of pino's types so consumers
 *    don't have to import from `pino` directly. Call sites use pino's
 *    native `(meta, msg)` API:
 *
 *        logger.info({ userId }, "user logged in");
 *        const child = logger.child({ scope: "sessions" });
 *
 * 2. `buildLogger(opts)` — factory wired to emploke's defaults: pretty
 *    pretty-printing in dev, JSON to stdout + rotating daily files in
 *    server mode. The pino streams write in a worker thread so the HTTP
 *    event loop is never blocked on disk IO.
 *
 * 3. `silentLogger` — a `pino({ level: "silent" })` instance to use as
 *    the default in any `logger?` constructor parameter, and in unit
 *    tests that don't care about log output. Pino short-circuits at the
 *    level check so silent logging incurs no serialization cost.
 *
 * 4. `@emploke/logger/testing` (separate entry) — `captureLogger()`
 *    that returns `{ logger, entries }` for tests that need to assert
 *    on log output.
 *
 * The full rationale for committing to pino lives inline in
 * `docs/architecture.md` under "Tech stack".
 */

export {
  type BuildLoggerOpts,
  buildLogger,
  type Logger,
  type LogLevel,
  silentLogger,
} from "./logger.js";
