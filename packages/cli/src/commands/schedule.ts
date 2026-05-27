/**
 * `emploke schedule …` — 8 subcommands wrapping the workspace-scoped
 * schedules HTTP surface (list / create / show / patch via enable +
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
        list.map((s) => [
          s.id ?? "",
          s.name ?? "",
          s.target?.kind === "task" ? (s.target.agent ?? "") : "",
          s.trigger?.kind === "cron" ? (s.trigger.expr ?? "") : "",
          s.trigger?.kind === "cron" ? (s.trigger.tz ?? "") : "",
          String(s.enabled),
        ]),
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
  readonly instructions: string;
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
  if (typeof opts.instructions !== "string" || opts.instructions === "") {
    return { exitCode: 2, stderr: "missing required --instructions <text>\n" };
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
    const target: {
      kind: "task";
      agent: string;
      instructions: string;
      runtime?: string;
    } = {
      kind: "task",
      agent: opts.agent,
      instructions: opts.instructions,
    };
    if (opts.runtime !== undefined) target.runtime = opts.runtime;
    const body = {
      name: opts.name,
      target,
      trigger: { kind: "cron" as const, expr: opts.cron, tz: opts.tz },
      enabled: !opts.disabled,
    };
    const created = await client.call("schedules.create", { params: { id }, body });
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
    const stdout = fmt === "json" ? formatJson(found) : formatRecord({ ...found });
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
    const updated = await client.call("schedules.patch", {
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
    await client.call("schedules.delete", { params: { id, sid: opts.sid } });
    return { exitCode: 0, stdout: `schedule ${opts.sid} removed\n` };
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
    return { exitCode: 0, stdout: `${result.taskId}\n` };
  } catch (err) {
    return formatError(err);
  }
}

// ─── preview ───────────────────────────────────────────────────────────
export interface SchedulePreviewOpts extends CommonFlags {
  readonly sid: string;
  /** Number of upcoming fires to compute (1..50). Capped at 3 in v1. */
  readonly n?: number;
}

export async function schedulePreview(opts: SchedulePreviewOpts): Promise<CommandResult> {
  if (typeof opts.sid !== "string" || opts.sid.trim() === "") {
    return { exitCode: 2, stderr: "schedule id is required\n" };
  }
  if (opts.n !== undefined && (!Number.isInteger(opts.n) || opts.n < 1 || opts.n > 50)) {
    return { exitCode: 2, stderr: "-n must be an integer in [1, 50]\n" };
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
