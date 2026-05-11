/**
 * `emploke restart` — `stop` then `start`. Trivial composition; lives in
 * its own file so the cac wiring in `index.ts` stays one-action-per-file.
 *
 * If `stop` returns a non-zero exit code we propagate it without trying
 * `start` — the operator should see the stop failure first.
 */

import type { CommandResult } from "../result.js";
import { type StartOpts, start } from "./start.js";
import { type StopOpts, stop } from "./stop.js";

export type RestartOpts = StartOpts & StopOpts;

export async function restart(opts: RestartOpts = {}): Promise<CommandResult> {
  const stopRes = await stop(opts);
  if (stopRes.exitCode !== 0) return stopRes;
  return start(opts);
}
