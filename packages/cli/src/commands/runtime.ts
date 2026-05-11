/**
 * `emploke runtime list` — `GET /api/runtimes`. Returns each registered
 * runtime's kind + capability bag (the wire shape was bumped from
 * `string[]` to `{kind, capabilities}[]` in server PR #55 so the
 * dashboard / CLI can branch on capability flags).
 */

import { makeClient } from "../connect.js";
import { formatError, formatJson, formatTable, pickFormat } from "../output.js";
import type { CommandResult } from "../result.js";

export interface RuntimeListOpts {
  readonly server?: string;
  readonly apiKey?: string;
  readonly home?: string;
  readonly output?: string;
  readonly json?: boolean;
}

export async function runtimeList(opts: RuntimeListOpts = {}): Promise<CommandResult> {
  const client = await makeClient(opts);
  try {
    const runtimes = await client.call("runtimes.list");
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(runtimes) };
    return {
      exitCode: 0,
      stdout: formatTable(
        ["kind", "capabilities"],
        runtimes.map((r) => [
          r.kind,
          // Render capability flag names; suppresses noisy `false` values.
          Object.entries(r.capabilities)
            .filter(([, v]) => v !== false && v !== null && v !== undefined)
            .map(([k]) => k)
            .join(", ") || "—",
        ]),
      ),
    };
  } catch (err) {
    return formatError(err);
  }
}
