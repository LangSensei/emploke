import { mkdirSync } from "node:fs";
import path from "node:path";
import pino, { type DestinationStream, type LoggerOptions, type Logger as PinoLogger } from "pino";

/**
 * Levels supported by `Logger`. Same ordering as pino: lower index =
 * more verbose. Filtering happens in pino itself, so a `debug` call
 * under a `warn`-or-higher logger never allocates the meta object.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Cross-package logging surface. Every persistence-touching manager
 * (TaskManager, SessionManager, ...) accepts an optional `logger`
 * config field with this shape. `meta` is structured context — a
 * shallow record of primitives or simple objects that the backend
 * serialises (for pino: into the log line's JSON properties).
 *
 * The interface intentionally has **no** child / withMeta / scoped
 * variants — those would couple call sites to pino's API. Callers that
 * want a "tagged" logger build a small wrapper inline (see e.g.
 * SessionManager passing `{ sessionId }` on every call).
 */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Drops every call. Use as the default in any `logger?` constructor
 * parameter, and in unit tests that don't care about log output.
 */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Configuration for `buildLogger`. All fields are optional. */
export interface BuildLoggerOpts {
  /**
   * Minimum level emitted. Default `"info"`. Set via env (server passes
   * `EMPLOKE_LOG_LEVEL`) or pinned in tests.
   */
  readonly level?: LogLevel;

  /**
   * Directory for rotated log files. When set, `pino-roll` writes
   * `<basename>-YYYY-MM-DD.log` here and keeps the configured number
   * of historical files. When unset, output goes to `stdout` only —
   * the right behaviour for short-lived CLIs and tests.
   *
   * The directory is created with `mkdirSync(..., { recursive: true })`
   * at boot. Failures throw — the server cannot reasonably continue if
   * its own log directory is unwritable, and silent fallback would
   * hide the misconfiguration from the operator.
   */
  readonly dir?: string;

  /**
   * Filename prefix under `dir`. Default `"server"`. Operators usually
   * leave this alone; tests or sidecar processes (future runtime
   * probes, etc) can scope their files with a different prefix.
   */
  readonly basename?: string;

  /**
   * Output format on stdout. `"pretty"` (default in dev) decorates
   * with colours / levels via `pino-pretty`; `"json"` (default when
   * `dir` is set, i.e. server-mode) emits raw JSON for jq / log
   * aggregators. File output is always JSON regardless of this
   * setting — pretty-printing files would defeat structured search.
   */
  readonly format?: "pretty" | "json";

  /**
   * Maximum size per rotated file. Default `"10M"`. pino-roll syntax
   * (`"K"`, `"M"`, `"G"` suffixes).
   */
  readonly maxSize?: string;

  /**
   * Number of historical files to retain after rotation. Default `7`.
   * On reaching the cap, pino-roll deletes the oldest.
   */
  readonly maxFiles?: number;
}

/**
 * Build a `Logger` backed by pino, optionally writing to a rotating
 * file destination.
 *
 * Output channels:
 *
 * - `dir` unset → stdout only, format chosen by `format` (default
 *   `"pretty"`). Suitable for one-shot CLIs and test runs.
 * - `dir` set → **two** destinations in parallel: stdout (format from
 *   `format`, default `"json"`), and pino-roll-managed daily files
 *   under `dir`. The two destinations receive the same lines, so
 *   stdout still tells the operator what's happening live while the
 *   files build a searchable history for after-the-fact debugging.
 *
 * The pino streams write in a worker thread so the HTTP event loop is
 * never blocked on disk IO — this is the main reason we picked pino
 * over `console.*` or a hand-rolled writer.
 */
export function buildLogger(opts: BuildLoggerOpts = {}): Logger {
  const level = opts.level ?? "info";
  const stdoutFormat = opts.format ?? (opts.dir ? "json" : "pretty");

  const stdoutTarget: { target: string; options: Record<string, unknown>; level: LogLevel } = {
    target: stdoutFormat === "pretty" ? "pino-pretty" : "pino/file",
    options: stdoutFormat === "pretty" ? { colorize: true, singleLine: false } : { destination: 1 },
    level,
  };

  let pinoLogger: PinoLogger;

  if (opts.dir) {
    // Eagerly create the dir so pino-roll's first write doesn't ENOENT.
    mkdirSync(opts.dir, { recursive: true });
    const basename = opts.basename ?? "server";
    const fileTarget = {
      target: "pino-roll",
      options: {
        file: path.join(opts.dir, basename),
        // pino-roll appends `.YYYY-MM-DD` and increments the size
        // suffix, e.g. server.2026-05-09, server.2026-05-09.1.
        frequency: "daily",
        size: opts.maxSize ?? "10M",
        limit: { count: opts.maxFiles ?? 7 },
        mkdir: true,
        // Always JSON in the file destination — files are for grep/jq,
        // pretty-printing would make the output unparseable.
      },
      level,
    };
    const transport = pino.transport({ targets: [stdoutTarget, fileTarget] });
    pinoLogger = pino({ level } satisfies LoggerOptions, transport as DestinationStream);
  } else {
    const transport = pino.transport({ targets: [stdoutTarget] });
    pinoLogger = pino({ level } satisfies LoggerOptions, transport as DestinationStream);
  }

  return adapt(pinoLogger);
}

/**
 * Wrap a pino logger as our narrower `Logger`. The wrapper exists so
 * call sites stay loosely coupled to pino's API surface; if we ever
 * swap backends, only this file changes.
 *
 * Pino's call signature is `(meta, msg)` — opposite order from our
 * `(msg, meta)`. The adapter swaps them and tolerates the
 * meta-omitted overload by passing `undefined`.
 */
function adapt(p: PinoLogger): Logger {
  return {
    debug: (msg, meta) => {
      if (meta) p.debug(meta, msg);
      else p.debug(msg);
    },
    info: (msg, meta) => {
      if (meta) p.info(meta, msg);
      else p.info(msg);
    },
    warn: (msg, meta) => {
      if (meta) p.warn(meta, msg);
      else p.warn(msg);
    },
    error: (msg, meta) => {
      if (meta) p.error(meta, msg);
      else p.error(msg);
    },
  };
}
