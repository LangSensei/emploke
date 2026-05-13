import { mkdirSync } from "node:fs";
import path from "node:path";
import pino, { type DestinationStream, type LoggerOptions } from "pino";

/**
 * `Logger` is pino's `Logger` type, re-exported. emploke commits to
 * pino at the type level — the previous 4-method facade was hiding
 * pino features (child loggers, redact, serializers) that the codebase
 * actually wants to use, in exchange for an abstraction whose payoff
 * (swapping logger backends) is hypothetical work that won't happen.
 * See `docs/architecture.md` → "Tech stack" for the concise rationale.
 *
 * Call sites use pino's API directly:
 *   logger.info({ userId }, "user logged in");           // meta, msg
 *   logger.info("user logged in");                       // msg only
 *   const child = logger.child({ scope: "sessions" });   // tagged child
 */
export type Logger = pino.Logger;

/**
 * Levels supported by `Logger`. Same ordering as pino: lower index =
 * more verbose. Filtering happens in pino itself, so a `debug` call
 * under a `warn`-or-higher logger never allocates the meta object.
 */
export type LogLevel = pino.Level;

/**
 * Drop-every-call sink. Backed by `pino({ level: "silent" })` — pino
 * short-circuits at the level check so silent logging incurs no
 * serialization or stream cost. Use as the default in any `logger?`
 * constructor parameter, and in unit tests that don't care about log
 * output.
 */
export const silentLogger: Logger = pino({ level: "silent" });

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
 * Build a `Logger` (i.e. `pino.Logger`), optionally writing to a
 * rotating file destination.
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
    return pino({ level } satisfies LoggerOptions, transport as DestinationStream);
  }

  const transport = pino.transport({ targets: [stdoutTarget] });
  return pino({ level } satisfies LoggerOptions, transport as DestinationStream);
}
