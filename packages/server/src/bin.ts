/**
 * Bundled binary entry point.
 *
 * The library entry (`./index.ts`) exports `runServer` for direct use;
 * this file is the foreground bin that gets run by
 * `node packages/server/dist/bin.js` (the published binary path before
 * the CLI takes over) and by the local `pnpm dev` workflow. The
 * dashboard is always shipped alongside the server, so we default
 * `--serve-static` ON unless the operator explicitly opts out with
 * `--no-serve-static`.
 *
 * Anything else — port, host, API key, EMPLOKE_HOME — is still controlled
 * by environment variables and read inside `runServer`.
 *
 * The CLI's `emploke serve` subcommand calls `runServer` directly with
 * the same default and does not go through this file.
 */

import { runServer } from "./index.js";

const serveStatic = !process.argv.includes("--no-serve-static");

await runServer({ serveStatic }).catch((err) => {
  // Boot-time failure: logger may not be alive yet, so fall back to
  // console.error here.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
