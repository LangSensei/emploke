/**
 * Shared helpers for the e2e tests that spawn the bundled `emploke`
 * CLI as a real subprocess.
 *
 * Previously duplicated verbatim across
 * `packages/cli/test/integration-smoke.test.ts` and
 * `packages/cli/test/spawn-smoke.test.ts`. Consolidated here when both
 * files moved into `@emploke/e2e`; semantics are unchanged.
 *
 * Requires `pnpm --filter @emploke/cli build` to have produced
 * `packages/cli/dist/bin.js`. CI does this in the build step before
 * `pnpm test`; locally, cases that depend on the bundle can either
 * throw in `beforeAll` (lifecycle/integration smoke) or skip
 * individually (`it.skipIf(!BIN_AVAILABLE)`, bundle smoke).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// `packages/e2e/test/_helpers/cli-bundle.ts` -> `packages/cli/dist/bin.js`
export const CLI_BIN = path.resolve(HERE, "..", "..", "..", "cli", "dist", "bin.js");
export const BIN_AVAILABLE = existsSync(CLI_BIN);

export interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the bundled CLI in a child process and capture stdout/stderr.
 *
 * Env merge: starts from `process.env`, then applies `env` on top.
 * Keys set to `undefined` in `env` are DELETED from the merged
 * result — this is the contract callers rely on to scrub
 * developer-shell env leaks (e.g. `EMPLOKE_SERVER` set by a
 * previous `pnpm dev`) before running a hermetic spawn.
 */
export function runBin(args: readonly string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
    for (const k of Object.keys(env)) {
      if (env[k] === undefined) delete merged[k];
    }
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: merged,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

export function pickPort(): number {
  // High random ephemeral-ish range; collisions are vanishingly rare and
  // the test surface (one server per file) tolerates the rare retry.
  return 30000 + Math.floor(Math.random() * 20000);
}
