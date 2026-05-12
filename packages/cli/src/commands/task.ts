/**
 * `emploke task …` — 5 subcommands wrapping the workspace-scoped tasks
 * HTTP surface (list / dispatch / show / rm / events).
 *
 * `events` is a one-shot dump of the runtime's NDJSON event log — the
 * server endpoint is also one-shot (no SSE / follow). Real follow mode
 * needs server-side support; tracked as a follow-up issue in plan.md.
 */

import { ApiError } from "../api-client.js";
import { makeClient, resolveWorkspace } from "../connect.js";
import { formatError, formatJson, formatRecord, formatTable, pickFormat } from "../output.js";
import type { CommandResult } from "../result.js";

interface CommonFlags {
  readonly server?: string;
  readonly apiKey?: string;
  readonly home?: string;
  readonly workspace?: string;
  readonly output?: string;
  readonly json?: boolean;
}

// ─── list ──────────────────────────────────────────────────────────────
export interface TaskListOpts extends CommonFlags {
  readonly agent?: string;
  readonly runtime?: string;
  readonly createdSince?: string;
  /** Comma-separated TaskStatus values. */
  readonly status?: string;
}

export async function taskList(opts: TaskListOpts = {}): Promise<CommandResult> {
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const query: { agent?: string; runtime?: string; createdSince?: string; status?: string } = {};
    if (opts.agent !== undefined) query.agent = opts.agent;
    if (opts.runtime !== undefined) query.runtime = opts.runtime;
    if (opts.createdSince !== undefined) query.createdSince = opts.createdSince;
    if (opts.status !== undefined) query.status = opts.status;
    const list = await client.call("tasks.list", { params: { id }, query });
    const fmt = pickFormat(opts, "table");
    if (fmt === "json") return { exitCode: 0, stdout: formatJson(list) };
    return {
      exitCode: 0,
      stdout: formatTable(
        ["id", "agent", "status", "createdAt"],
        list.map((t) => [
          (t as { id?: string }).id ?? "",
          (t as { agent?: string }).agent ?? "",
          (t as { status?: string }).status ?? "",
          (t as { createdAt?: string }).createdAt ?? "",
        ]),
      ),
    };
  } catch (err) {
    return formatError(err);
  }
}

// ─── dispatch ──────────────────────────────────────────────────────────
export interface TaskDispatchOpts extends CommonFlags {
  readonly agent: string;
  readonly instructions: string;
  readonly runtime?: string;
}

export async function taskDispatch(opts: TaskDispatchOpts): Promise<CommandResult> {
  if (typeof opts.agent !== "string" || opts.agent.trim() === "") {
    return { exitCode: 2, stderr: "missing required --agent <name>\n" };
  }
  if (typeof opts.instructions !== "string" || opts.instructions.trim() === "") {
    return { exitCode: 2, stderr: "missing required --instructions <text>\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const body: { agent: string; instructions: string; runtime?: string } = {
      agent: opts.agent,
      instructions: opts.instructions,
    };
    if (opts.runtime !== undefined) body.runtime = opts.runtime;
    const task = await client.call("tasks.dispatch", { params: { id }, body });
    const fmt = pickFormat(opts, "table");
    const stdout = fmt === "json" ? formatJson(task) : formatRecord({ ...task });
    return { exitCode: 0, stdout };
  } catch (err) {
    return formatError(err);
  }
}

// ─── show ──────────────────────────────────────────────────────────────
export interface TaskShowOpts extends CommonFlags {
  readonly tid: string;
}

export async function taskShow(opts: TaskShowOpts): Promise<CommandResult> {
  if (typeof opts.tid !== "string" || opts.tid.trim() === "") {
    return { exitCode: 2, stderr: "task id is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const task = await client.call("tasks.get", { params: { id, tid: opts.tid } });
    const fmt = pickFormat(opts, "table");
    const stdout = fmt === "json" ? formatJson(task) : formatRecord({ ...task });
    return { exitCode: 0, stdout };
  } catch (err) {
    return formatError(err);
  }
}

// ─── rm ────────────────────────────────────────────────────────────────
export interface TaskRmOpts extends CommonFlags {
  readonly tid: string;
  readonly purge?: boolean;
}

export async function taskRm(opts: TaskRmOpts): Promise<CommandResult> {
  if (typeof opts.tid !== "string" || opts.tid.trim() === "") {
    return { exitCode: 2, stderr: "task id is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const query: { purge?: "1" } = {};
    if (opts.purge) query.purge = "1";
    await client.call("tasks.delete", { params: { id, tid: opts.tid }, query });
    return { exitCode: 0, stdout: `task ${opts.tid} removed\n` };
  } catch (err) {
    return formatError(err);
  }
}

// ─── events ────────────────────────────────────────────────────────────
export interface TaskEventsOpts extends CommonFlags {
  readonly tid: string;
  /** Test seam: write destination for streamed bytes. Defaults to `process.stdout`. */
  readonly out?: NodeJS.WritableStream;
}

export async function taskEvents(opts: TaskEventsOpts): Promise<CommandResult> {
  if (typeof opts.tid !== "string" || opts.tid.trim() === "") {
    return { exitCode: 2, stderr: "task id is required\n" };
  }
  const out = opts.out ?? process.stdout;
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    // Use callRaw so the NDJSON body is streamed directly to stdout —
    // events logs can be megabytes for long-running tasks; buffering
    // through `call` would consume RAM proportional to log size and
    // delay any output until the server closes the connection.
    const res = await client.callRaw("tasks.events", { params: { id, tid: opts.tid } });
    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = await res.text();
      }
      throw new ApiError(res.status, `HTTP ${res.status}`, body);
    }
    if (res.body !== null) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          out.write(decoder.decode(value, { stream: true }));
        }
        const tail = decoder.decode();
        if (tail) out.write(tail);
      } finally {
        reader.releaseLock();
      }
    }
    return { exitCode: 0 };
  } catch (err) {
    return formatError(err);
  }
}

// ─── activity ──────────────────────────────────────────────────────────
export interface TaskActivityOpts extends CommonFlags {
  readonly tid: string;
}

export async function taskActivity(opts: TaskActivityOpts): Promise<CommandResult> {
  if (typeof opts.tid !== "string" || opts.tid.trim() === "") {
    return { exitCode: 2, stderr: "task id is required\n" };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts, client);
    const payload = await client.call("tasks.activity", { params: { id, tid: opts.tid } });
    // Activity is intrinsically structured (variant ActivityItem types);
    // human-readable rendering is left to higher layers. Always JSON.
    return { exitCode: 0, stdout: formatJson(payload) };
  } catch (err) {
    return formatError(err);
  }
}
