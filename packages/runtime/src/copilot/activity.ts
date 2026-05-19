import type {
  ActivityItem,
  AssistantItem,
  Attachment,
  SummaryItem,
  SummaryStats,
  SystemItem,
  ThinkingItem,
  TokenUsage,
  ToolCallItem,
  UserItem,
} from "../types.js";

/**
 * Copilot CLI's NDJSON event log parser. Each line is a JSON object
 * shaped roughly:
 *
 *   { "type": "<event-name>", "timestamp": "<iso>", "id": "<uuid>",
 *     "data": { ... }, "parentId": "<uuid>|null" }
 *
 * Translated into the cross-runtime {@link ActivityItem} vocabulary:
 *
 *   - `user.message` -> {@link UserItem} (with attachments when present)
 *   - `assistant.message` -> {@link AssistantItem}, plus one
 *     {@link ToolCallItem} per `toolRequests[]` entry (status: running).
 *     When the data carries `reasoningText` (extended-thinking models
 *     like Claude with thinking enabled), a {@link ThinkingItem} is
 *     emitted FIRST so the timeline reads think-then-speak.
 *   - `tool.execution_start` -> {@link ToolCallItem} (status: running)
 *     when no matching toolRequest already created the item
 *   - `tool.execution_complete` -> merged into existing
 *     {@link ToolCallItem} via `callId` (flips status to success/error,
 *     populates result + durationMs)
 *   - `session.shutdown` -> {@link SummaryItem} with stats + tokens
 *   - `hook.start/end`, `skill.invoked`, `subagent.{started,completed}`,
 *     `system.notification`, `session.error` -> {@link SystemItem}
 *
 * Filtered out (kept in the raw log only): `session.start`,
 * `session.info`, `session.model_change`, `system.message`,
 * `assistant.turn_start`, `assistant.turn_end`. These carry useful
 * signal for low-level debugging but not for the timeline view.
 */

interface ParsedEvent {
  readonly type: string;
  readonly timestamp: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly data: Record<string, unknown>;
}

interface BaseFields {
  readonly seq: number;
  readonly id: string;
  readonly parentSeq?: number;
  readonly timestamp: string;
}

/**
 * Parse the raw Copilot NDJSON into the runtime-neutral
 * {@link ActivityItem} stream. Items are returned in the order they
 * appeared in the log; `seq` is assigned 0..N-1 in that order so it
 * doubles as the canonical cursor.
 */
export function parseCopilotActivity(raw: string): ActivityItem[] {
  const parser = new CopilotActivityStreamParser();
  const out: ActivityItem[] = [];
  for (const line of splitLines(raw)) {
    const result = parser.parseLine(line);
    for (const item of result.items) {
      out.push(item);
    }
  }
  // Stream parser returns mutated tool-call items each time, so the
  // out[] above can carry duplicates (same seq) when a complete event
  // arrives. Collapse to last-write-wins.
  const bySeq = new Map<number, ActivityItem>();
  for (const item of out) {
    bySeq.set(item.seq, item);
  }
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
}

/**
 * Pick the last `assistant.message` content as the run's "result" -
 * this is the line a user wants to see when revisiting a finished
 * task ("oh, the agent said X").
 */
export function deriveCopilotResult(raw: string): string | null {
  for (const line of splitLines(raw).reverse()) {
    const ev = parseSingleEvent(line);
    if (ev === null || ev.type !== "assistant.message") continue;
    const content = pickString(ev.data, "content");
    if (content !== null && content.length > 0) return content;
  }
  return null;
}

export interface ParseLineResult {
  readonly items: readonly ActivityItem[];
}

/**
 * Stateful per-stream parser used by both
 * {@link parseCopilotActivity} (one shot) and
 * `CopilotRuntime.streamActivity` (live tail). Maintains the
 * tool-call merge map across line boundaries so begin/end events
 * arriving in separate writes still merge.
 *
 * When `tool.execution_complete` arrives for an in-progress
 * tool_call, the parser yields the SAME `seq` again with the
 * updated status. SSE consumers and the dashboard must dedup by
 * `seq` (last-write-wins).
 */
export class CopilotActivityStreamParser {
  private seq: number;
  private readonly toolCallSeqByCallId = new Map<string, number>();
  private readonly idToSeq = new Map<string, number>();
  private readonly itemsBySeq = new Map<number, ActivityItem>();

  constructor(startSeq = 0) {
    this.seq = startSeq;
  }

  parseLine(line: string): ParseLineResult {
    const ev = parseSingleEvent(line);
    if (ev === null) return { items: [] };

    const items: ActivityItem[] = [];
    const baseId = ev.id;
    const parentSeq = ev.parentId !== null ? this.idToSeq.get(ev.parentId) : undefined;
    const baseFields: BaseFields = {
      seq: this.seq,
      id: baseId,
      ...(parentSeq !== undefined ? { parentSeq } : {}),
      timestamp: ev.timestamp,
    };

    if (ev.type === "user.message") {
      const text = pickString(ev.data, "content") ?? "";
      const attachments = parseAttachments(ev.data.attachments);
      const item: UserItem = {
        kind: "user",
        ...baseFields,
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      this.commit(item);
      items.push(item);
    } else if (ev.type === "assistant.message") {
      const text = pickString(ev.data, "content") ?? "";
      const model = pickString(ev.data, "model") ?? undefined;
      const tokens = parseAssistantTokens(ev.data);
      // Thinking trace, if present, gets its own item BEFORE the assistant
      // message so the timeline reads think → speak. We mint a derived id
      // (`<eventId>-thinking`) so the seq -> item map and parentSeq lookups
      // don't collide with the assistant item that shares the source event id.
      const reasoningText = pickString(ev.data, "reasoningText");
      if (reasoningText !== null && reasoningText.length > 0) {
        const thinkingItem: ThinkingItem = {
          kind: "thinking",
          seq: this.seq,
          id: `${baseId}-thinking`,
          ...(parentSeq !== undefined ? { parentSeq } : {}),
          timestamp: ev.timestamp,
          text: reasoningText,
        };
        this.commit(thinkingItem);
        items.push(thinkingItem);
      }
      const assistantParentSeq =
        reasoningText !== null && reasoningText.length > 0 ? this.seq - 1 : parentSeq;
      const item: AssistantItem = {
        kind: "assistant",
        seq: this.seq,
        id: baseId,
        ...(assistantParentSeq !== undefined ? { parentSeq: assistantParentSeq } : {}),
        timestamp: ev.timestamp,
        text,
        ...(model !== undefined ? { model } : {}),
        ...(tokens !== null ? { tokens } : {}),
      };
      this.commit(item);
      items.push(item);
      const assistantSeq = item.seq;
      for (const tr of parseToolRequestsRaw(ev.data.toolRequests)) {
        const callId = tr.toolCallId ?? `${baseId}-tool-${this.seq}`;
        const callItem: ToolCallItem = {
          kind: "tool_call",
          seq: this.seq,
          id: callId,
          parentSeq: assistantSeq,
          timestamp: ev.timestamp,
          callId,
          name: tr.name,
          ...(tr.args !== undefined ? { args: tr.args } : {}),
          status: "running",
        };
        this.commit(callItem);
        this.toolCallSeqByCallId.set(callId, callItem.seq);
        items.push(callItem);
      }
    } else if (ev.type === "tool.execution_start") {
      const callId = pickString(ev.data, "toolCallId");
      if (callId !== null && this.toolCallSeqByCallId.has(callId)) {
        return { items: [] };
      }
      const name = pickString(ev.data, "toolName") ?? "<unknown>";
      const args = pickObject(ev.data, "arguments");
      const item: ToolCallItem = {
        kind: "tool_call",
        ...baseFields,
        callId: callId ?? baseId,
        name,
        ...(args !== undefined ? { args } : {}),
        status: "running",
      };
      this.commit(item);
      if (callId !== null) {
        this.toolCallSeqByCallId.set(callId, item.seq);
      }
      items.push(item);
    } else if (ev.type === "tool.execution_complete") {
      const callId = pickString(ev.data, "toolCallId");
      const success = ev.data.success === true;
      const result = ev.data.result;
      if (callId !== null && this.toolCallSeqByCallId.has(callId)) {
        const targetSeq = this.toolCallSeqByCallId.get(callId);
        if (targetSeq === undefined) return { items: [] };
        const existing = this.itemsBySeq.get(targetSeq) as ToolCallItem | undefined;
        if (existing === undefined) return { items: [] };
        const startMs = Date.parse(existing.timestamp);
        const endMs = Date.parse(ev.timestamp);
        const durationMs =
          Number.isFinite(startMs) && Number.isFinite(endMs)
            ? Math.max(0, endMs - startMs)
            : undefined;
        const display = extractToolDisplay(result);
        const updated: ToolCallItem = {
          ...existing,
          status: success ? "success" : "error",
          ...(result !== undefined ? { result } : {}),
          ...(display !== undefined ? { display } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        };
        this.itemsBySeq.set(targetSeq, updated);
        items.push(updated);
        // Don't bump seq — same item, mutated in place.
      } else {
        const name = pickString(ev.data, "toolName") ?? "<unknown>";
        const display = extractToolDisplay(result);
        const item: ToolCallItem = {
          kind: "tool_call",
          ...baseFields,
          callId: callId ?? baseId,
          name,
          status: success ? "success" : "error",
          ...(result !== undefined ? { result } : {}),
          ...(display !== undefined ? { display } : {}),
        };
        this.commit(item);
        items.push(item);
      }
    } else if (
      ev.type === "skill.invoked" ||
      ev.type === "subagent.started" ||
      ev.type === "subagent.completed" ||
      ev.type === "system.notification" ||
      ev.type === "session.error"
    ) {
      // hook.start / hook.end are intentionally NOT lifted — they fire
      // before AND after every tool call (Copilot's pre/postToolUse
      // observability hooks) and carry no signal beyond what the
      // adjacent tool_call item already shows. Keeping them would
      // bury real timeline content under hook.start/hook.end pairs.
      const subKind = systemSubKind(ev.type);
      const text =
        pickString(ev.data, "message") ??
        pickString(ev.data, "name") ??
        pickString(ev.data, "skillName") ??
        pickString(ev.data, "agentName") ??
        ev.type;
      const level: SystemItem["level"] = ev.type === "session.error" ? "error" : "info";
      const item: SystemItem = {
        kind: "system",
        ...baseFields,
        text,
        level,
        subKind,
      };
      this.commit(item);
      items.push(item);
    } else if (ev.type === "session.shutdown") {
      const summary = parseShutdown(ev.data, baseFields);
      this.commit(summary);
      items.push(summary);
    }
    // Other event types intentionally dropped.

    return { items };
  }

  get nextSeq(): number {
    return this.seq;
  }

  private commit(item: ActivityItem): void {
    this.itemsBySeq.set(item.seq, item);
    if (item.id !== undefined) this.idToSeq.set(item.id, item.seq);
    this.seq += 1;
  }
}

// ─── helpers ─────────────────────────────────────────────────────

function splitLines(raw: string): string[] {
  const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return normalized.split(/\r?\n/);
}

function parseSingleEvent(line: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (
      obj &&
      typeof obj === "object" &&
      typeof obj.type === "string" &&
      typeof obj.timestamp === "string" &&
      typeof obj.id === "string"
    ) {
      const data =
        obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)
          ? (obj.data as Record<string, unknown>)
          : {};
      const parentId = typeof obj.parentId === "string" ? obj.parentId : null;
      return {
        type: obj.type,
        timestamp: obj.timestamp,
        id: obj.id,
        parentId,
        data,
      };
    }
  } catch {
    // Drop malformed lines silently.
  }
  return null;
}

function pickString(d: Record<string, unknown>, key: string): string | null {
  const v = d[key];
  return typeof v === "string" ? v : null;
}

function pickObject(d: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = d[key];
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function numOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

interface RawToolRequest {
  readonly name: string;
  readonly args?: Record<string, unknown>;
  readonly toolCallId?: string;
}

function parseToolRequestsRaw(raw: unknown): RawToolRequest[] {
  if (!Array.isArray(raw)) return [];
  const out: RawToolRequest[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name : null;
    if (name === null) continue;
    const args = pickObject(obj, "arguments");
    const toolCallId =
      typeof obj.toolCallId === "string"
        ? obj.toolCallId
        : typeof obj.id === "string"
          ? obj.id
          : undefined;
    out.push({
      name,
      ...(args !== undefined ? { args } : {}),
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    });
  }
  return out;
}

function parseAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const obj = a as Record<string, unknown>;
    const mimeType = pickString(obj, "mimeType") ?? pickString(obj, "contentType");
    const url = pickString(obj, "url");
    const data = pickString(obj, "data") ?? pickString(obj, "base64");
    const name = pickString(obj, "name") ?? pickString(obj, "filename");
    if (url === null && data === null) continue;
    const kind: Attachment["kind"] = mimeType?.startsWith("image/") ? "image" : "file";
    out.push({
      kind,
      ...(mimeType !== null ? { mimeType } : {}),
      ...(url !== null ? { url } : {}),
      ...(data !== null ? { data } : {}),
      ...(name !== null ? { name } : {}),
    });
  }
  return out;
}

function parseAssistantTokens(d: Record<string, unknown>): TokenUsage | null {
  // Copilot's `assistant.message.data` only carries `outputTokens`. The
  // input token count for that turn lives in `session.shutdown.modelMetrics`
  // as an aggregate across the whole session — not per message. Earlier
  // versions returned `{ input: 0, output, total: output }` which was a
  // lie (the ":input is 0" reading was wrong; it really means "unknown")
  // and broke downstream `input > 0 || output > 0` checks. We now omit
  // `input` / `total` per the new optional shape; consumers render the
  // output count alone and fall back to "—" or skip the input column.
  const output = numOrUndefined(d.outputTokens);
  if (output === undefined) return null;
  return { output };
}

function systemSubKind(eventType: string): string {
  if (eventType.startsWith("skill.")) return "skill";
  if (eventType.startsWith("subagent.")) return "subagent";
  if (eventType === "system.notification") return "notification";
  if (eventType === "session.error") return "error";
  return "other";
}

/**
 * Extract a human-readable rendering hint from Copilot's
 * `tool.execution_complete.result` payload. Copilot ships
 * `{content, detailedContent}` where `content` is the one-line
 * summary suitable for inline display in the timeline (e.g.
 * "Intent logged") and `detailedContent` is the verbose form
 * (kept opaque in `result` for the "Result" detail toggle).
 *
 * Returns `undefined` when the payload doesn't fit the recognised
 * shape, so the dashboard falls back to its generic JSON renderer.
 */
function extractToolDisplay(
  result: unknown,
): { readonly content: string; readonly markdown?: boolean } | undefined {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return undefined;
  const obj = result as Record<string, unknown>;
  const content = pickString(obj, "content") ?? pickString(obj, "textResultForLlm");
  if (content === null) return undefined;
  return { content };
}

function parseShutdown(raw: Record<string, unknown>, baseFields: BaseFields): SummaryItem {
  const cc = pickObject(raw, "codeChanges");
  const linesAdded = numOrUndefined(cc?.linesAdded);
  const linesRemoved = numOrUndefined(cc?.linesRemoved);
  const filesModified = Array.isArray(cc?.filesModified)
    ? (cc?.filesModified as unknown[]).filter((f): f is string => typeof f === "string")
    : undefined;
  const premiumRequests = numOrUndefined(raw.totalPremiumRequests);

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let model: string | undefined;
  if (raw.modelMetrics && typeof raw.modelMetrics === "object") {
    for (const [k, v] of Object.entries(raw.modelMetrics as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const usage = (v as Record<string, unknown>).usage;
      if (usage && typeof usage === "object") {
        const u = usage as Record<string, unknown>;
        // Anthropic prompt-cache + extended-thinking accounting:
        //   cacheReadTokens   — re-used cached input (~1/10 price)
        //   cacheWriteTokens  — initial cache write (~1.25× input price)
        //   reasoningTokens   — extended-thinking output (already counted
        //                       toward outputTokens upstream, surfaced
        //                       separately so operators can see thinking
        //                       cost vs reply cost)
        // Sum across models so multi-model sessions get one bill view.
        inputTokens += numOr0(u.inputTokens);
        outputTokens += numOr0(u.outputTokens);
        cachedTokens += numOr0(u.cacheReadTokens);
        cacheWriteTokens += numOr0(u.cacheWriteTokens);
        reasoningTokens += numOr0(u.reasoningTokens);
      }
      if (model === undefined) model = k;
    }
  }
  if (typeof raw.currentModel === "string") model = raw.currentModel;

  const tokens: TokenUsage | undefined =
    inputTokens > 0 || outputTokens > 0
      ? {
          input: inputTokens,
          output: outputTokens,
          ...(cachedTokens > 0 ? { cached: cachedTokens } : {}),
          ...(cacheWriteTokens > 0 ? { cacheWrite: cacheWriteTokens } : {}),
          ...(reasoningTokens > 0 ? { reasoning: reasoningTokens } : {}),
          total: inputTokens + outputTokens,
        }
      : undefined;

  const stats: SummaryStats = {
    ...(filesModified !== undefined && filesModified.length > 0 ? { filesModified } : {}),
    ...(linesAdded !== undefined ? { linesAdded } : {}),
    ...(linesRemoved !== undefined ? { linesRemoved } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(premiumRequests !== undefined ? { premiumRequests } : {}),
  };

  return {
    kind: "summary",
    ...baseFields,
    ...(tokens !== undefined ? { tokens } : {}),
    ...(Object.keys(stats).length > 0 ? { stats } : {}),
  };
}
