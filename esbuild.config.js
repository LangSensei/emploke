/**
 * Bundle the emploke CLI (and the server it embeds, plus all workspace
 * packages reachable from them) into a single executable JS file at
 * `bundle/emploke.js`.
 *
 * Output is the `bin` entry of the published `@langsensei/emploke`
 * npm package. At install time, npm symlinks `emploke` to this file;
 * running `emploke` enters the CLI dispatcher (`@emploke/cli`), which
 * subcommands either talk to a running server over HTTP or, in the
 * case of `serve` / `start`, drive the embedded server directly.
 *
 * Mirrors the approach used by google-gemini/gemini-cli: keep workspace
 * packages private, ship one bundled binary, externalize anything that
 * relies on filesystem-resolved transports (pino) or native bindings.
 */

import esbuild from "esbuild";

// pino + its transports use `__dirname` and dynamic `require()` inside a
// worker_threads.Worker to load destinations at runtime. Inlining them
// breaks both — the worker file path becomes invalid and the transport
// strings ("pino-pretty", "pino-roll") can't be resolved. Keep them as
// real `require()` calls and ship them as runtime dependencies of the
// published package so npm install resolves them in the user's
// node_modules. `thread-stream` is pino's worker entry point and is
// pulled transitively, but listing it explicitly avoids esbuild walking
// into it accidentally if the dep graph shifts.
const external = ["pino", "pino-pretty", "pino-roll", "thread-stream"];

const result = await esbuild.build({
  entryPoints: { emploke: "packages/cli/src/bin.ts" },
  outdir: "bundle",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external,
  banner: {
    js: [
      "#!/usr/bin/env node",
      // Recreate `require` and `__dirname`/`__filename` for any inlined
      // CJS code that expects them. Without this, dependencies that call
      // `require()` (or use `__dirname`) at bundle scope crash under ESM.
      "import { createRequire as _emp_cr } from 'node:module';",
      "import { fileURLToPath as _emp_furl } from 'node:url';",
      "import { dirname as _emp_dn } from 'node:path';",
      "const require = _emp_cr(import.meta.url);",
      "const __filename = _emp_furl(import.meta.url);",
      "const __dirname = _emp_dn(__filename);",
    ].join("\n"),
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  logLevel: "info",
});

if (result.errors.length > 0) {
  process.exit(1);
}
