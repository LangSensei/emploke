/**
 * `emploke serve` — run the HTTP server in the foreground (current
 * pre-CLI behaviour, kept for dev workflows). Delegates to `runServer`
 * from `@emploke/server` with `--serve-static` defaulted ON, mirroring
 * what the historical `bundle/emploke.js` bin did.
 *
 * This function does NOT return — once the server is listening, the
 * process stays alive on the open http handle until SIGTERM / SIGINT
 * triggers `runServer`'s graceful shutdown.
 */

import { type RunServerOpts, runServer } from "@emploke/server";

export interface ServeOpts {
  readonly port?: number;
  readonly host?: string;
  readonly apiKey?: string;
  /** Defaults to `true` (production binary behaviour). Pass `false` for source-mode dev. */
  readonly serveStatic?: boolean;
  readonly staticDir?: string;
  readonly logLevel?: "debug" | "info" | "warn" | "error";
  readonly logFormat?: "pretty" | "json";
}

export async function serve(opts: ServeOpts = {}): Promise<never> {
  const runOpts: RunServerOpts = {
    serveStatic: opts.serveStatic ?? true,
  };
  if (opts.port !== undefined) {
    (runOpts as { port?: number }).port = opts.port;
  }
  if (opts.host !== undefined) {
    (runOpts as { host?: string }).host = opts.host;
  }
  if (opts.apiKey !== undefined) {
    (runOpts as { apiKey?: string }).apiKey = opts.apiKey;
  }
  if (opts.staticDir !== undefined) {
    (runOpts as { staticDir?: string }).staticDir = opts.staticDir;
  }
  if (opts.logLevel !== undefined) {
    (runOpts as { logLevel?: "debug" | "info" | "warn" | "error" }).logLevel = opts.logLevel;
  }
  if (opts.logFormat !== undefined) {
    (runOpts as { logFormat?: "pretty" | "json" }).logFormat = opts.logFormat;
  }
  await runServer(runOpts);
  // runServer resolves once the http listener is bound; we deliberately
  // never resolve from here so the bin layer doesn't `process.exit` and
  // tear down the listening socket. The server's own SIGTERM / SIGINT
  // handlers (registered inside runServer) call `process.exit` after
  // graceful shutdown completes.
  return new Promise<never>(() => {});
}
