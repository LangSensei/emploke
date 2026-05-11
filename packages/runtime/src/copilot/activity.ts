import type { ActivityItem, ActivitySummary, ToolRequest } from "../types.js";

/**
 * Copilot CLI's NDJSON event log parser. Each line is a JSON object
 * shaped roughly:
 *
 *   { "type": "<event-name>", "timestamp": "<iso>", "id": "<uuid>",
 *     "data": { ... }, "parentId": "<uuid>|null" }
 *
 * The event taxonomy we care about (others are dropped as low-signal):
 *
 *   - `user.message` — `data.content` is the user's prompt
 *   - `assistant.message` — `data.content` + `data.toolRequests`
 *   - `session.shutdown` — terminal stats (codeChanges, modelMetrics,
 *      totalPremiumRequests, ...) → ActivitySummary
 *
 * Filtered out (kept in the raw log only): `session.start`,
 * `session.model_change`, `system.message`, `assistant.turn_start`,
 * `assistant.turn_end`. These carry useful signal for debugging but
 * not for the "what happened in this task" timeline view.
 */

interface ParsedEvent {
  readonly type: string;
  readonly timestamp: string;
  readonly id: string;
  readonly data: Record<string, unknown>;
}

export function parseCopilotActivity(raw: string): ActivityItem[] {
  const events = parseEvents(raw);
  const out: ActivityItem[] = [];
  for (const ev of events) {
    if (ev.type === "user.message") {
      const content = pickString(ev.data, "content") ?? "";
      out.push({ kind: "user", timestamp: ev.timestamp, content });
    } else if (ev.type === "assistant.message") {
      const content = pickString(ev.data, "content") ?? "";
      const toolRequests = parseToolRequests(ev.data.toolRequests);
      out.push({ kind: "assistant", timestamp: ev.timestamp, content, toolRequests });
    } else if (ev.type === "session.shutdown") {
      const summary = parseShutdown(ev.data);
      if (summary !== null) {
        out.push({ kind: "summary", timestamp: ev.timestamp, summary });
      }
    }
  }
  return out;
}

/**
 * Pick the last `assistant.message` content as the run's "result" —
 * this is the line a user wants to see when revisiting a finished
 * task ("oh, the agent said X").
 */
export function deriveCopilotResult(raw: string): string | null {
  const events = parseEvents(raw);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined || ev.type !== "assistant.message") continue;
    const content = pickString(ev.data, "content");
    if (content !== null && content.length > 0) return content;
  }
  return null;
}

function parseEvents(raw: string): ParsedEvent[] {
  // Strip leading UTF-8 BOM that some loggers emit; without this the
  // first line fails JSON.parse and we lose a real event.
  const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const out: ParsedEvent[] = [];
  for (const line of normalized.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
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
        out.push({
          type: obj.type,
          timestamp: obj.timestamp,
          id: obj.id,
          data,
        });
      }
    } catch {
      // Drop malformed lines silently; the raw view will still surface them.
    }
  }
  return out;
}

function pickString(d: Record<string, unknown>, key: string): string | null {
  const v = d[key];
  return typeof v === "string" ? v : null;
}

function parseToolRequests(raw: unknown): ToolRequest[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolRequest[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name : null;
    if (name === null) continue;
    const args =
      obj.arguments && typeof obj.arguments === "object" && !Array.isArray(obj.arguments)
        ? (obj.arguments as Record<string, unknown>)
        : undefined;
    out.push({ name, arguments: args });
  }
  return out;
}

function parseShutdown(raw: Record<string, unknown>): ActivitySummary | null {
  const cc = raw.codeChanges;
  const codeChanges =
    cc && typeof cc === "object" && !Array.isArray(cc) ? (cc as Record<string, unknown>) : null;
  const linesAdded = numOr0(codeChanges?.linesAdded);
  const linesRemoved = numOr0(codeChanges?.linesRemoved);
  const filesModified = Array.isArray(codeChanges?.filesModified)
    ? (codeChanges?.filesModified as unknown[]).filter((f): f is string => typeof f === "string")
    : [];
  const premiumRequests = numOr0(raw.totalPremiumRequests);
  // Aggregate input/output tokens across all model entries; the wire
  // format breaks them down per-model but consumers want a single
  // total at the summary level.
  let inputTokens = 0;
  let outputTokens = 0;
  let model: string | null = null;
  if (raw.modelMetrics && typeof raw.modelMetrics === "object") {
    for (const [k, v] of Object.entries(raw.modelMetrics as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const usage = (v as Record<string, unknown>).usage;
      if (usage && typeof usage === "object") {
        const u = usage as Record<string, unknown>;
        inputTokens += numOr0(u.inputTokens);
        outputTokens += numOr0(u.outputTokens);
      }
      if (model === null) model = k;
    }
  }
  if (typeof raw.currentModel === "string") model = raw.currentModel;
  return {
    linesAdded,
    linesRemoved,
    filesModified,
    premiumRequests,
    inputTokens,
    outputTokens,
    model,
  };
}

function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
