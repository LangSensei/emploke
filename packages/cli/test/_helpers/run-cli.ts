/**
 * In-process CLI invoker for argv-layer and api-contract tests.
 *
 * Calls `run(argv)` from `../../src/index.ts` directly (no spawn, no
 * server) while capturing every byte written to `process.stdout` /
 * `process.stderr` and applying scoped env overrides. Restores both
 * streams + env on return so concurrent tests can't leak state.
 *
 * Why not spawn: the historical `commands.test.ts` paid a full
 * `node bin.js` cold-start (~50–200 ms) per case, even for ones that
 * only checked argv parsing. Going in-process drops each case to a
 * handful of milliseconds — see issue #163 for the failure analysis.
 *
 * Why not a global fetch reset: callers that need a mock fetch should
 * stub it themselves with `vi.spyOn(globalThis, "fetch")` and restore
 * via `vi.restoreAllMocks()` / `mockRestore()`. Keeping the fetch
 * lifecycle outside this helper means argv-only tests don't pay for
 * a stub they don't use.
 */

import { run } from "../../src/index.js";

export interface RunCaptured {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Invoke the CLI in-process with `[node, emploke, ...args]` and capture
 * its output. `env` entries override `process.env` for the duration of
 * the call; pass `undefined` to delete an inherited key (e.g.
 * `EMPLOKE_WORKSPACE: undefined` to test the "no workspace selected"
 * path even when the dev shell has one exported).
 */
export async function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<RunCaptured> {
  let stdout = "";
  let stderr = "";

  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);

  // Snapshot the env keys we're about to mutate so we can restore them
  // exactly (including the unset case — `delete process.env.X` differs
  // from `process.env.X = ""` for callers that check truthiness).
  const snapshot: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    snapshot[key] = process.env[key];
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  // Coerce every chunk to a UTF-8 string. The real streams accept
  // strings | Buffers | Uint8Arrays; for tests we only need to capture
  // a printable view. The `as never` casts suppress the
  // overload-mismatch warning from process.stdout.write's three-arity
  // signature without bringing in `@types/node`'s `Writable` shape.
  const capture =
    (sink: (s: string) => void) =>
    (chunk: unknown): boolean => {
      if (typeof chunk === "string") sink(chunk);
      else if (chunk instanceof Uint8Array) sink(Buffer.from(chunk).toString("utf8"));
      else sink(String(chunk));
      return true;
    };
  process.stdout.write = capture((s) => {
    stdout += s;
  }) as never;
  process.stderr.write = capture((s) => {
    stderr += s;
  }) as never;

  try {
    const exitCode = await run(["node", "emploke", ...args]);
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = origOut as never;
    process.stderr.write = origErr as never;
    for (const key of Object.keys(snapshot)) {
      const prev = snapshot[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}
