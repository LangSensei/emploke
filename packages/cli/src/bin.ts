/**
 * Bundled binary entry point for the `emploke` CLI. Bundled by
 * `esbuild.config.js` to `bundle/emploke.js`; the root `package.json`'s
 * `bin.emploke` field points there.
 *
 * No shebang here — esbuild's banner adds one to the bundled output for
 * the `npm install`-symlinked executable path. In source / monorepo dev
 * we always invoke this file via `node` / `tsx`, where the shebang is
 * irrelevant; an in-source shebang would survive the bundle and produce
 * a duplicate, breaking ESM parsing on Node ≥ 22.
 *
 * Keep this file minimal — every interesting decision happens in
 * `./index.ts`.
 */

import { run } from "./index.js";

const code = await run(process.argv);
process.exit(code);
