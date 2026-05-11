/**
 * `emploke config` — `GET /api/config`. Surfaces the server's resolved
 * paths, listening host/port, and dashboard tunables. Useful for
 * scripting (`--json`) or verifying that an `EMPLOKE_HOME` override
 * landed where you expected.
 */

import { makeClient } from "../connect.js";
import { formatError, formatJson, formatRecord, pickFormat } from "../output.js";
import type { CommandResult } from "../result.js";

export interface ConfigOpts {
  readonly server?: string;
  readonly apiKey?: string;
  readonly home?: string;
  readonly output?: string;
  readonly json?: boolean;
}

export async function config(opts: ConfigOpts = {}): Promise<CommandResult> {
  const client = await makeClient(opts);
  try {
    const cfg = await client.call("config.get");
    const fmt = pickFormat(opts, "table");
    const stdout =
      fmt === "json"
        ? formatJson(cfg)
        : formatRecord({
            emplokeHome: cfg.emplokeHome,
            currentWorkspace: cfg.currentWorkspace ?? "(none)",
            host: cfg.host,
            port: cfg.port,
            pathSeparator: cfg.pathSeparator,
            tasksPollIntervalMs: cfg.tasks.pollIntervalMs,
          });
    return { exitCode: 0, stdout };
  } catch (err) {
    return formatError(err);
  }
}
