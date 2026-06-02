/**
 * `emploke serve` — run the HTTP server in the foreground.
 *
 * The `emploke` binary is *both* the client CLI and the server bundle:
 * client subcommands (`task list`, `agent install`, …) speak HTTP to a
 * running server, and `serve` is the entry point that boots that
 * server in-process. `emploke start` is just `spawn("emploke serve",
 * { detached: true })` plus a `/api/health` wait — same bin, different
 * lifecycle.
 *
 * That's why this file is the one place in `@emploke/cli` allowed to
 * value-import from `@emploke/server`: this *is* the server boot path.
 * Every other cli↔server interaction goes over HTTP through
 * `api-client.ts` using wire contracts from `@emploke/contracts`.
 *
 * This function does NOT return — once the server is listening, the
 * process stays alive on the open http handle until SIGTERM / SIGINT
 * triggers `runServer`'s graceful shutdown.
 */

import { type RunServerOpts, runServer } from "@emploke/server";

export interface ServeOpts {
  readonly port?: number;
  readonly host?: string;
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
