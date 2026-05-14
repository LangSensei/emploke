/**
 * `emploke health` — `GET /api/health`. Exits 0 on a 200 with
 * `status: ok`; non-zero is delegated to {@link formatError}.
 *
 * Distinct from `emploke status`: `status` reads the local
 * `runtime.json` to find a server we know about and reports lifecycle
 * health (running / not running / unhealthy). `health` makes a live
 * HTTP request against the resolved `--server` (which may be remote)
 * and surfaces the server's self-reported version + uptime.
 */

import { makeClient } from "../connect.js";
import { formatError, formatJson, formatRecord, pickFormat } from "../output.js";
import type { CommandResult } from "../result.js";

export interface HealthOpts {
  readonly server?: string;
  readonly home?: string;
  readonly output?: string;
  readonly json?: boolean;
}

export async function health(opts: HealthOpts = {}): Promise<CommandResult> {
  const client = await makeClient(opts);
  try {
    const snap = await client.call("health.get");
    const fmt = pickFormat(opts, "table");
    const stdout =
      fmt === "json"
        ? formatJson(snap)
        : formatRecord({
            status: snap.status,
            name: snap.name,
            version: snap.version,
            uptimeSec: snap.uptimeSec,
            startedAt: snap.startedAt,
            serverNow: snap.serverNow,
          });
    return { exitCode: 0, stdout };
  } catch (err) {
    return formatError(err);
  }
}
