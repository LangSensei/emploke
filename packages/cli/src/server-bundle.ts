/**
 * Resolve the path to the bundled CLI binary (== bundled server) so
 * `start` can spawn it as a detached child with a `serve` subcommand.
 *
 * In the published `@langsensei/emploke` package, the CLI and the
 * server are baked into the same `bundle/emploke.js` file (esbuild
 * inlines both). At runtime the CLI is the entry; `process.argv[1]`
 * gives that path.
 *
 * In source / monorepo dev (running the CLI via tsx), `process.argv[1]`
 * still points at the script the node executable was launched with
 * (`packages/cli/src/bin.ts`); the caller is then responsible for
 * passing `nodeArgs` like `["--import", "tsx"]` to `start` so the
 * spawned child can load the TS source.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Best-effort resolution of the script path that should be passed to
 * `node` as the first positional arg when spawning the detached server.
 *
 * Priority:
 *  1. `process.argv[1]` if it exists — the script we were invoked as.
 *  2. `import.meta.url` of this module — fallback for the (unusual)
 *     case where the CLI was loaded via `node -e "import('@emploke/cli')"`
 *     and there is no argv[1].
 */
export function resolveSelfBin(): string {
  const argv1 = process.argv[1];
  if (typeof argv1 === "string" && argv1.length > 0 && existsSync(argv1)) {
    return argv1;
  }
  return fileURLToPath(import.meta.url);
}
