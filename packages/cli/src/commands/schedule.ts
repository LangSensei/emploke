/**
 * `emploke schedule …` — 9 subcommands wrapping the workspace-scoped
 * schedules HTTP surface (list / create / show / patch + enable +
 * disable / delete / run / preview) plus `list-tasks` which wraps the
 * sibling `scheduledTasks.list` route so users can audit which tasks
 * a schedule has launched.
 *
 * Shape mirrors `commands/task.ts` exactly — every function takes opts,
 * returns a `CommandResult`, and the commander wiring lives in
 * `index.ts`. No commander imports here; this file is pure business
 * logic so tests can call the functions directly without going through
 * argv parsing.
 */

import { makeClient, resolveWorkspace } from "../connect.js";
import { formatError, formatJson, formatRecord, formatTable, pickFormat } from "../output.js";
import type { CommandResult } from "../result.js";

interface CommonFlags {
  readonly server?: string;
  readonly home?: string;
  readonly workspace?: string;
  readonly output?: string;
  readonly json?: boolean;
}

// ─── list ──────────────────────────────────────────────────────────────
export interface ScheduleListOpts extends CommonFlags {
  readonly agent?: string;
  /** `"true"` / `"false"` — passed through as the query param's string value. */
  readonly enabled?: string;
}

export async function scheduleList(opts: ScheduleListOpts = {}): Promise<CommandResult> {
  if (opts.enabled !== undefined && opts.enabled !== "true" && opts.enabled !== "false") {
    return {
      exitCode: 2,
      stderr: '--enabled must be "true" or "false"\n',
    };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const query: { agent?: string; enabled?: "true" | "false" } = {};
    if (opts.agent !== undefined) query.agent = opts.agent;
    if (opts.enabled !== undefined) query.enabled = opts.enabled as "true" | "false";
    const list = await client.call("schedules.list", { params: { id }, query });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(list) };
    return {
      exitCode: 0,
      stdout: formatTable(
        ["id", "name", "agent", "cron", "tz", "enabled"],
        list.map((s) => {
          // The wire shape for the task kind is flat
          // (`TaskScheduleTargetWire`); future kinds project as
          // opaque `{ kind, data }`. Cast through `unknown` for the
          // task case so TypeScript accepts the property access
          // even though the union member type isn't fully
          // narrowable on a `kind: string` supertype.
          const target = s.target as { kind: string; agent?: string };
          return [
            s.id ?? "",
            s.name ?? "",
            target.kind === "task" ? (target.agent ?? "") : "",
            s.trigger?.kind === "cron" ? (s.trigger.expr ?? "") : "",
            s.trigger?.kind === "cron" ? (s.trigger.tz ?? "") : "",
            String(s.enabled),
          ];
        }),
      ),
    };
  } catch (err) {
    return formatError(err);
  }
}

// ─── create ────────────────────────────────────────────────────────────
export interface ScheduleCreateOpts extends CommonFlags {
  readonly name: string;
  readonly agent: string;
  /** Short, single-line task title (≤ 200 chars). Required. */
  readonly brief: string;
  /** Optional long-form details. Multi-line allowed. */
  readonly details?: string;
  readonly cron: string;
  readonly tz: string;
  readonly runtime?: string;
  /** When true, the schedule is created in disabled state. Defaults to false (enabled). */
  readonly disabled?: boolean;
}

export async function scheduleCreate(opts: ScheduleCreateOpts): Promise<CommandResult> {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    return { exitCode: 2, stderr: "missing required --name <text>\n" };
  }
  if (typeof opts.agent !== "string" || opts.agent.trim() === "") {
    return { exitCode: 2, stderr: "missing required --agent <fqn>\n" };
  }
  // --brief mirrors `emploke task dispatch --brief` exactly (see
  // commands/task.ts): required, no newlines, ≤ 200 trimmed chars.
  if (typeof opts.brief !== "string" || opts.brief.trim() === "") {
    return { exitCode: 2, stderr: "missing required --brief <text>\n" };
  }
  if (opts.brief.includes("\n") || opts.brief.includes("\r")) {
    return {
      exitCode: 2,
      stderr:
        "--brief must be a single line (no newline characters); pass long content via --details\n",
    };
  }
  if (opts.brief.trim().length > 200) {
    return { exitCode: 2, stderr: "--brief must be 200 characters or fewer\n" };
  }
  if (typeof opts.cron !== "string" || opts.cron.trim() === "") {
    return { exitCode: 2, stderr: "missing required --cron <expr>\n" };
  }
  if (typeof opts.tz !== "string" || opts.tz.trim() === "") {
    return { exitCode: 2, stderr: "missing required --tz <iana>\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    // No `kind` field — the URL (`POST /schedules/task`) declares it.
    const target: {
      agent: string;
      brief: string;
      details?: string;
      runtime?: string;
    } = {
      agent: opts.agent,
      brief: opts.brief.trim(),
    };
    if (opts.details !== undefined) target.details = opts.details;
    if (opts.runtime !== undefined) target.runtime = opts.runtime;
    const body = {
      name: opts.name,
      target,
      trigger: { kind: "cron" as const, expr: opts.cron, tz: opts.tz },
      enabled: !opts.disabled,
    };
    const created = await client.call("schedules.task.create", { params: { id }, body });
    const fmt = pickFormat(opts, "table");
    const stdout = fmt === "json" ? formatJson(created) : formatRecord({ ...created });
    return { exitCode: 0, stdout };
  } catch (err) {
    return formatError(err);
  }
}

// ─── show ──────────────────────────────────────────────────────────────
export interface ScheduleShowOpts extends CommonFlags {
  readonly sid: string;
}

export async function scheduleShow(opts: ScheduleShowOpts): Promise<CommandResult> {
  if (typeof opts.sid !== "string" || opts.sid.trim() === "") {
    return { exitCode: 2, stderr: "schedule id is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const found = await client.call("schedules.get", { params: { id, sid: opts.sid } });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(found) };
    // Surface `describe` (the derived zh_CN cron text the server
    // adds to GET /:sid) right after `name` so it lands above the
    // structured `trigger` / `target` JSON blobs in the table view.
    const { id: foundId, name, describe, ...rest } = found;
    const stdout = formatRecord({
      id: foundId,
      name,
      describe: describe ?? "(no description)",
      ...rest,
    });
    return { exitCode: 0, stdout };
  } catch (err) {
    return formatError(err);
  }
}

// ─── enable / disable (thin wrappers over schedules.patch) ─────────────
export interface ScheduleEnableOpts extends CommonFlags {
  readonly sid: string;
}

export async function scheduleEnable(opts: ScheduleEnableOpts): Promise<CommandResult> {
  return patchEnabled(opts, true, "enabled");
}

export async function scheduleDisable(opts: ScheduleEnableOpts): Promise<CommandResult> {
  return patchEnabled(opts, false, "disabled");
}

async function patchEnabled(
  opts: ScheduleEnableOpts,
  enabled: boolean,
  verb: string,
): Promise<CommandResult> {
  if (typeof opts.sid !== "string" || opts.sid.trim() === "") {
    return { exitCode: 2, stderr: "schedule id is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const updated = await client.call("schedules.task.patch", {
      params: { id, sid: opts.sid },
      body: { enabled },
    });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(updated) };
    return { exitCode: 0, stdout: `schedule ${opts.sid} ${verb}\n` };
  } catch (err) {
    return formatError(err);
  }
}

// ─── rm ────────────────────────────────────────────────────────────────
export interface ScheduleRmOpts extends CommonFlags {
  readonly sid: string;
}

export async function scheduleRm(opts: ScheduleRmOpts): Promise<CommandResult> {
  if (typeof opts.sid !== "string" || opts.sid.trim() === "") {
    return { exitCode: 2, stderr: "schedule id is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const result = await client.call("schedules.delete", {
      params: { id, sid: opts.sid },
    });
    const n = result.deletedDispatchCount;
    const suffix =
      n === 0 ? "" : n === 1 ? " (and 1 historical dispatch)" : ` (and ${n} historical dispatches)`;
    return { exitCode: 0, stdout: `schedule ${opts.sid} removed${suffix}\n` };
  } catch (err) {
    return formatError(err);
  }
}

// ─── run (manual fire-now) ─────────────────────────────────────────────
export interface ScheduleRunOpts extends CommonFlags {
  readonly sid: string;
}

export async function scheduleRun(opts: ScheduleRunOpts): Promise<CommandResult> {
  if (typeof opts.sid !== "string" || opts.sid.trim() === "") {
    return { exitCode: 2, stderr: "schedule id is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const result = await client.call("schedules.run", { params: { id, sid: opts.sid } });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(result) };
    return { exitCode: 0, stdout: `${result.dispatchId}\n` };
  } catch (err) {
    return formatError(err);
  }
}

// ─── preview ───────────────────────────────────────────────────────────
export interface SchedulePreviewOpts extends CommonFlags {
  readonly sid: string;
  /** Number of upcoming fires to compute (1..100). */
  readonly n?: number;
}

export async function schedulePreview(opts: SchedulePreviewOpts): Promise<CommandResult> {
  if (typeof opts.sid !== "string" || opts.sid.trim() === "") {
    return { exitCode: 2, stderr: "schedule id is required\n" };
  }
  if (opts.n !== undefined && (!Number.isInteger(opts.n) || opts.n < 1 || opts.n > 100)) {
    return { exitCode: 2, stderr: "-n must be an integer in [1, 100]\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const query: { n?: string } = {};
    if (opts.n !== undefined) query.n = String(opts.n);
    const preview = await client.call("schedules.preview", {
      params: { id, sid: opts.sid },
      query,
    });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(preview) };
    const lines = [preview.describe, ...preview.nextRuns.map((ts) => `  ${ts}`)];
    return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
  } catch (err) {
    return formatError(err);
  }
}

// ─── patch (general partial update) ────────────────────────────────────
export interface SchedulePatchOpts extends CommonFlags {
  readonly sid: string;
  readonly name?: string;
  readonly cron?: string;
  readonly tz?: string;
  readonly agent?: string;
  /** Replace the brief. Mirrors `emploke task dispatch --brief` validation. */
  readonly brief?: string;
  /**
   * Replace the details with `value` (including `""` — mirrors the
   * task CLI's lax shape). Mutually exclusive with --clear-details.
   *
   * Note: emploke's `pickString` collapses `--details ""` to undefined
   * (treated as omitted) at the commander boundary, so the empty-string
   * SET case is only reachable via direct API / dashboard.
   */
  readonly details?: string;
  /**
   * Remove `details` from the patched target entirely (sends
   * `target.details: null` on the wire — RFC 7396 delete semantics).
   * Distinct from `--details ""`, which SETS details to the empty
   * string. Mutually exclusive with --details.
   */
  readonly clearDetails?: boolean;
  readonly runtime?: string;
  /**
   * Remove `runtime` from the patched target entirely (sends
   * `target.runtime: null` on the wire — RFC 7396 delete semantics).
   * Mutually exclusive with --runtime.
   */
  readonly clearRuntime?: boolean;
  readonly enabled?: boolean;
}

export async function schedulePatch(opts: SchedulePatchOpts): Promise<CommandResult> {
  if (typeof opts.sid !== "string" || opts.sid.trim() === "") {
    return { exitCode: 2, stderr: "schedule id is required\n" };
  }

  if (opts.clearDetails === true && opts.details !== undefined) {
    return {
      exitCode: 2,
      stderr: "--details and --clear-details are mutually exclusive\n",
    };
  }
  if (opts.clearRuntime === true && opts.runtime !== undefined) {
    return {
      exitCode: 2,
      stderr: "--runtime and --clear-runtime are mutually exclusive\n",
    };
  }

  // Validate --brief content up-front (mirrors `scheduleCreate`):
  // non-empty, no newlines, ≤ 200 trimmed chars.
  if (opts.brief !== undefined) {
    if (typeof opts.brief !== "string" || opts.brief.trim() === "") {
      return { exitCode: 2, stderr: "--brief must be a non-empty string\n" };
    }
    if (opts.brief.includes("\n") || opts.brief.includes("\r")) {
      return {
        exitCode: 2,
        stderr:
          "--brief must be a single line (no newline characters); pass long content via --details\n",
      };
    }
    if (opts.brief.trim().length > 200) {
      return { exitCode: 2, stderr: "--brief must be 200 characters or fewer\n" };
    }
  }

  const touchesTrigger = opts.cron !== undefined || opts.tz !== undefined;
  const touchesTarget =
    opts.agent !== undefined ||
    opts.brief !== undefined ||
    opts.details !== undefined ||
    opts.clearDetails === true ||
    opts.runtime !== undefined ||
    opts.clearRuntime === true;
  const touchesAny =
    opts.name !== undefined || touchesTrigger || touchesTarget || opts.enabled !== undefined;
  if (!touchesAny) {
    return {
      exitCode: 2,
      stderr:
        "at least one of --name / --cron / --tz / --agent / --brief / --details / --clear-details / --runtime / --clear-runtime / --enabled is required\n",
    };
  }

  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);

    // `target` is RFC 7396 deep-merged server-side (see
    // packages/server/src/routes/schedules.ts `PATCH /task/:sid`),
    // so the CLI no longer needs to GET-merge target leaves before
    // sending the patch. `trigger`, however, is still wholesale-
    // replace (small atomic shape), so a partial trigger update
    // (--cron OR --tz, but not both) still requires one GET to fill
    // the other field. This is the only remaining GET-merge case.
    let current: Awaited<ReturnType<typeof client.call<"schedules.get">>> | undefined;
    const needCurrentForTrigger =
      touchesTrigger && !(opts.cron !== undefined && opts.tz !== undefined);
    if (needCurrentForTrigger) {
      current = await client.call("schedules.get", { params: { id, sid: opts.sid } });
    }

    const body: {
      name?: string;
      trigger?: { kind: "cron"; expr: string; tz: string };
      target?: {
        agent?: string;
        brief?: string;
        details?: string | null;
        runtime?: string | null;
      };
      enabled?: boolean;
    } = {};

    if (opts.name !== undefined) body.name = opts.name;
    if (opts.enabled !== undefined) body.enabled = opts.enabled;

    if (touchesTrigger) {
      const existingTrigger = current?.trigger;
      // v1 only models `cron` triggers (see types.ts); guard so a
      // future `interval` schedule doesn't get silently coerced by
      // the CLI's --cron / --tz flags.
      if (existingTrigger !== undefined && existingTrigger.kind !== "cron") {
        return {
          exitCode: 2,
          stderr: `--cron / --tz only supported when current trigger.kind === "cron" (got "${existingTrigger.kind}")\n`,
        };
      }
      const expr = opts.cron ?? existingTrigger?.expr;
      const tz = opts.tz ?? existingTrigger?.tz;
      if (expr === undefined || tz === undefined) {
        // Unreachable in practice — GET must return a complete
        // trigger when one exists — but keep the defensive guard so
        // a contract regression surfaces with a clear message instead
        // of as an opaque server 400.
        return { exitCode: 2, stderr: "internal: could not resolve cron/tz from server\n" };
      }
      body.trigger = { kind: "cron", expr, tz };
    }

    if (touchesTarget) {
      // Sparse target — server deep-merges per field. No GET needed.
      const nextTarget: {
        agent?: string;
        brief?: string;
        details?: string | null;
        runtime?: string | null;
      } = {};
      if (opts.agent !== undefined) nextTarget.agent = opts.agent;
      if (opts.brief !== undefined) nextTarget.brief = opts.brief.trim();
      if (opts.clearDetails === true) nextTarget.details = null;
      else if (opts.details !== undefined) nextTarget.details = opts.details;
      if (opts.clearRuntime === true) nextTarget.runtime = null;
      else if (opts.runtime !== undefined) nextTarget.runtime = opts.runtime;
      body.target = nextTarget;
    }

    const updated = await client.call("schedules.task.patch", {
      params: { id, sid: opts.sid },
      body,
    });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(updated) };
    return { exitCode: 0, stdout: `schedule ${opts.sid} patched\n` };
  } catch (err) {
    return formatError(err);
  }
}

// ─── list-tasks (wraps scheduledTasks.list) ────────────────────────────
export interface ScheduleListTasksOpts extends CommonFlags {
  readonly scheduleId?: string;
  readonly agent?: string;
  readonly runtime?: string;
  readonly createdSince?: string;
  /** Comma-separated TaskStatus values. */
  readonly status?: string;
}

export async function scheduleListTasks(opts: ScheduleListTasksOpts = {}): Promise<CommandResult> {
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);
    const query: {
      scheduleId?: string;
      agent?: string;
      runtime?: string;
      createdSince?: string;
      status?: string;
    } = {};
    if (opts.scheduleId !== undefined) query.scheduleId = opts.scheduleId;
    if (opts.agent !== undefined) query.agent = opts.agent;
    if (opts.runtime !== undefined) query.runtime = opts.runtime;
    if (opts.createdSince !== undefined) query.createdSince = opts.createdSince;
    if (opts.status !== undefined) query.status = opts.status;
    const list = await client.call("scheduledTasks.list", { params: { id }, query });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(list) };
    return {
      exitCode: 0,
      stdout: formatTable(
        ["id", "agent", "status", "scheduleId", "createdAt"],
        list.map((t) => {
          const meta = (t as { metadata?: { scheduleId?: string } }).metadata;
          return [
            (t as { id?: string }).id ?? "",
            (t as { agent?: string }).agent ?? "",
            (t as { status?: string }).status ?? "",
            meta?.scheduleId ?? "",
            (t as { createdAt?: string }).createdAt ?? "",
          ];
        }),
      ),
    };
  } catch (err) {
    return formatError(err);
  }
}
