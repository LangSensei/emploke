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
const external = [
  "pino",
  "pino-pretty",
  "pino-roll",
  "thread-stream",
  // better-sqlite3 is a native module with a `.node` binding loaded
  // via `bindings` at runtime by walking the filesystem from the
  // module location. Inlining the JS shim into our single-file
  // bundle breaks the bindings search (it looks under the bundle
  // path, not under node_modules/better-sqlite3/build/). Keep it as
  // a real `require()` and declare it as a runtime `dependency` of
  // `@langsensei/emploke` so `npm install` materialises the prebuilt
  // binary into the user's node_modules tree. `bindings` is the
  // tiny resolver better-sqlite3 uses; same treatment.
  "better-sqlite3",
  "bindings",
  // @github/copilot-sdk wraps the @github/copilot CLI and resolves it at
  // runtime via `import.meta.resolve('@github/copilot/sdk')` (verified
  // against @github/copilot-sdk@1.0.0-beta.4). That call walks the
  // SDK module's own node_modules — which only exists when npm has
  // materialised the SDK alongside its transitive `@github/copilot`
  // dep. Inlining the SDK into our single-file bundle severs both
  // sides of that lookup: the SDK code now lives at the bundle path
  // (not at `node_modules/@github/copilot-sdk/`), and the CLI dep is
  // never installed in the user's tree because the bundled SDK source
  // can't carry its own `dependencies` declaration. Result is a
  // silent `ERR_MODULE_NOT_FOUND` at first dispatch.
  //
  // Externalising keeps the SDK as a real `import` whose resolution
  // happens through the user's installed `node_modules/@github/
  // copilot-sdk/`, which npm sets up correctly because we declare the
  // SDK in the root `package.json` `dependencies`. The SDK's own
  // `@github/copilot` dep is then resolved transitively by npm — we
  // do NOT declare the CLI directly because that would couple us to
  // its version twice (once via the SDK's package.json, once via
  // ours) and drift on every SDK bump.
  "@github/copilot-sdk",
];

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
