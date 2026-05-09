/**
 * Bundled binary entry point.
 *
 * The dev/source entry (`./index.ts`) is also reachable via
 * `node packages/server/src/index.ts` and respects an explicit
 * `--serve-static` flag from the command line. The bundled binary is
 * what users get after `npm install -g @langsensei/emploke`, where the
 * dashboard is always shipped alongside the server — so we default
 * `--serve-static` ON unless the operator explicitly opts out with
 * `--no-serve-static`.
 *
 * Anything else — port, host, API key, EMPLOKE_HOME — is still controlled
 * by environment variables and read inside `./index.ts`.
 */

if (!process.argv.includes("--serve-static") && !process.argv.includes("--no-serve-static")) {
  process.argv.push("--serve-static");
}

await import("./index.js");

export {};
