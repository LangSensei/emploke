/**
 * `emploke task …` — 5 subcommands wrapping the workspace-scoped tasks
 * HTTP surface (list / dispatch / show / rm / activity).
 *
 * `activity` returns the runtime-parsed `ActivityItem[]` timeline as
 * JSON — runtime-neutral, so multi-runtime futures work without the
 * client needing to know how each CLI persists its log.
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
    const id = await resolveWorkspace(opts);
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
    const id = await resolveWorkspace(opts);
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
    const id = await resolveWorkspace(opts);
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
    const id = await resolveWorkspace(opts);
    const query: { purge?: "1" } = {};
    if (opts.purge) query.purge = "1";
    await client.call("tasks.delete", { params: { id, tid: opts.tid }, query });
    return { exitCode: 0, stdout: `task ${opts.tid} removed\n` };
  } catch (err) {
    return formatError(err);
  }
}

// ─── activity ──────────────────────────────────────────────────────────
export interface TaskActivityOpts extends CommonFlags {
  readonly tid: string;
  /** Tail the live activity stream over SSE; exits when the task terminates. */
  readonly follow?: boolean;
  /**
   * Backward pagination: return items with `seq < before`. Mutually
   * exclusive with --after; rejected by the server as 400 if both
   * are supplied. Use to walk older history one page at a time.
   */
  readonly before?: number;
  /**
   * Forward pagination: return items with `seq > after`. With
   * --follow, sent as `Last-Event-ID: <after>` to resume the SSE
   * stream from that seq. Without --follow, used as `?after=` query.
   */
  readonly after?: number;
  /** Maximum items per page. Server clamps to [1, 500]; default 50. */
  readonly limit?: number;
}

export async function taskActivity(opts: TaskActivityOpts): Promise<CommandResult> {
  if (typeof opts.tid !== "string" || opts.tid.trim() === "") {
    return { exitCode: 2, stderr: "task id is required\n" };
  }
  if (opts.before !== undefined && opts.after !== undefined) {
    return {
      exitCode: 2,
      stderr: "--before and --after are mutually exclusive\n",
    };
  }
  if (opts.follow === true && opts.before !== undefined) {
    return {
      exitCode: 2,
      stderr:
        "--before cannot be combined with --follow (--follow resumes forward only; pass --after instead)\n",
    };
  }
  const client = await makeClient(opts);
  try {
    const id = await resolveWorkspace(opts);

    if (opts.follow === true) {
      return await followTaskActivity(client, id, opts.tid, opts.after);
    }

    const query: { before?: string; after?: string; limit?: string } = {};
    if (opts.before !== undefined) query.before = String(opts.before);
    if (opts.after !== undefined) query.after = String(opts.after);
    if (opts.limit !== undefined) query.limit = String(opts.limit);
    const payload = await client.call("tasks.activity", {
      params: { id, tid: opts.tid },
      query,
    });
    // Activity is intrinsically structured (variant ActivityItem types);
    // human-readable rendering is left to higher layers. Always JSON.
    return { exitCode: 0, stdout: formatJson(payload) };
  } catch (err) {
    return formatError(err);
  }
}

/**
 * Live-tail an in-progress task by streaming SSE from the
 * `/activity/stream` endpoint. Each ActivityItem is printed as a
 * single NDJSON line on stdout (pipe-friendly: `... | jq -c`,
 * `... | grep error`).
 *
 * Exits 0 when the server sends `event: end` (task terminal) or the
 * stream closes cleanly. Exits non-zero on transport / framing
 * errors. SIGINT (Ctrl+C) terminates the process between frames.
 *
 * Resume: pass `after` to send `Last-Event-ID: <after>` so the
 * server replays from that seq. Conversely, on every clean / mid-
 * stream-error exit we print `last seq: <N>` to stderr so the next
 * invocation can resume:
 *
 *   emploke task activity <tid> --follow                       # tail from now
 *   emploke task activity <tid> --follow --after 1234          # resume from seq 1234
 *
 * Inside Ctrl+C the process dies between frames and stderr is not
 * written; recover the last seq from stdout instead
 * (`... | tail -1 | jq .seq`) since each printed item carries its
 * own `seq`.
 */
export async function followTaskActivity(
  client: import("../api-client.js").ApiClient,
  id: string,
  tid: string,
  after: number | undefined,
): Promise<CommandResult> {
  const headers = after !== undefined ? { "Last-Event-ID": String(after) } : undefined;
  const res = await client.callRaw("tasks.activity.stream", {
    params: { id, tid },
    ...(headers !== undefined ? { headers } : {}),
  });
  if (res.status === 404) {
    return { exitCode: 1, stderr: `task ${tid} has no streaming activity (terminal or missing)\n` };
  }
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      // ignore
    }
    return { exitCode: 1, stderr: `HTTP ${res.status}: ${body || res.statusText}\n` };
  }
  if (res.body === null) {
    return { exitCode: 1, stderr: "server returned an empty body\n" };
  }

  // Stream + frame-split on \n\n.
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";
  let stdout = "";
  // Seed lastSeq from the resume `after` so a stream that immediately
  // ends (no items replayed) still produces a recoverable hint —
  // e.g. resume `after` was already at HEAD.
  let lastSeq: string | undefined = after !== undefined ? String(after) : undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const frameEnd = buffer.indexOf("\n\n");
        if (frameEnd === -1) break;
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        const parsed = parseSseFrame(frame);
        if (parsed === null) continue;
        if (parsed.id !== undefined) lastSeq = parsed.id;
        if (parsed.event === "end") {
          return withResumeHint({ exitCode: 0, stdout }, lastSeq);
        }
        if (parsed.event === "error") {
          return withResumeHint(
            { exitCode: 1, stdout, stderr: `stream error: ${parsed.data}\n` },
            lastSeq,
          );
        }
        if (parsed.event === "activity") {
          // Ensure single-line NDJSON: re-stringify (no indent) so
          // multi-line item content stays on one line.
          try {
            const item = JSON.parse(parsed.data);
            stdout += `${JSON.stringify(item)}\n`;
          } catch {
            // Forward malformed frames verbatim for debuggability.
            stdout += `${parsed.data}\n`;
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  return withResumeHint({ exitCode: 0, stdout }, lastSeq);
}

/** Append a `last seq: <N>` resume hint to the result's stderr (no-op when no events were observed). */
function withResumeHint(result: CommandResult, lastSeq: string | undefined): CommandResult {
  if (lastSeq === undefined) return result;
  const tail = `last seq: ${lastSeq}\n`;
  const existing = result.stderr ?? "";
  return { ...result, stderr: `${existing}${tail}` };
}

/** Parse a single SSE frame (event: + data: + id: lines, no comments / retry). */
function parseSseFrame(frame: string): { event: string; data: string; id?: string } | null {
  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    } else if (line.startsWith("id:")) {
      // id: per SSE spec — used by `tasks.activity.stream` to expose
      // each item's monotonic `seq`. Tracking it is what makes
      // `--after` resume work.
      id = line.slice(3).trim();
    }
    // Ignore `retry:` and comments — we don't need them client-side.
  }
  if (dataLines.length === 0) return null;
  return id !== undefined
    ? { event, data: dataLines.join("\n"), id }
    : { event, data: dataLines.join("\n") };
}
