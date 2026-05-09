/**
 * Bundle the emploke server (and all workspace packages) into a single
 * executable JS file at bundle/emploke.js.
 *
 * Output is meant to be the `bin` entry of a published npm package
 * (@langsensei/emploke). At install time, npm symlinks `emploke` to this
 * file; running `emploke` boots the HTTP server with the dashboard
 * pre-bundled into `bundle/static/`.
 *
 * Mirrors the approach used by google-gemini/gemini-cli: keep workspace
 * packages private, ship one bundle.
 */

import esbuild from "esbuild";

const result = await esbuild.build({
  entryPoints: { emploke: "packages/server/src/bin.ts" },
  outdir: "bundle",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // No externals: workspace packages and runtime deps (hono, js-yaml,
  // @hono/node-server) all get inlined. If a native module ever needs to
  // stay external, list it here.
  external: [],
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
