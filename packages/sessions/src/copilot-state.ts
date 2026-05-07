import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { realNormalizeCwd } from "./paths.js";
import type { CopilotSessionInfo, Logger } from "./types.js";

/** A discovered Copilot session, keyed by its normalized cwd for joining. */
export interface CopilotSessionEntry {
  /** Normalized cwd (key for joining to emploke workdirs). */
  readonly cwdKey: string;
  /** Best-effort metadata; see CopilotSessionInfo. */
  readonly info: CopilotSessionInfo;
}

/**
 * Scan `~/.copilot/session-state/` and yield one entry per session whose
 * `workspace.yaml` is parseable and has a string `cwd`. Other fields are
 * best-effort; missing/invalid values map to undefined rather than failing
 * the whole entry.
 *
 * Tolerates a missing copilotStateDir (returns []).
 */
export async function scanCopilotSessions(
  copilotStateDir: string,
  logger: Logger,
): Promise<CopilotSessionEntry[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(copilotStateDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: CopilotSessionEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sessionId = e.name;
    const yamlPath = path.join(copilotStateDir, sessionId, "workspace.yaml");
    let raw: string;
    try {
      raw = await readFile(yamlPath, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      logger.warn("sessions: failed to parse workspace.yaml", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    const cwdRaw = obj.cwd;
    if (typeof cwdRaw !== "string" || cwdRaw.length === 0) continue;
    const cwdKey = await realNormalizeCwd(cwdRaw);
    const info: CopilotSessionInfo = {
      sessionId,
      ...(typeof obj.name === "string" ? { name: obj.name } : {}),
      ...(typeof obj.summary === "string" ? { summary: obj.summary } : {}),
      ...parseDate(obj.created_at, "createdAt"),
      ...parseDate(obj.updated_at, "updatedAt"),
    };
    out.push({ cwdKey, info });
  }
  return out;
}

/** Build a cwdKey -> entries[] map, sorted desc by updatedAt within each key. */
export function indexByCwd(
  entries: readonly CopilotSessionEntry[],
): Map<string, CopilotSessionInfo[]> {
  const map = new Map<string, CopilotSessionInfo[]>();
  for (const e of entries) {
    const arr = map.get(e.cwdKey);
    if (arr) arr.push(e.info);
    else map.set(e.cwdKey, [e.info]);
  }
  for (const arr of map.values()) {
    arr.sort(byUpdatedAtDesc);
  }
  return map;
}

function byUpdatedAtDesc(a: CopilotSessionInfo, b: CopilotSessionInfo): number {
  const at = a.updatedAt?.getTime() ?? 0;
  const bt = b.updatedAt?.getTime() ?? 0;
  return bt - at;
}

function parseDate(
  v: unknown,
  field: "createdAt" | "updatedAt",
): Partial<Pick<CopilotSessionInfo, "createdAt" | "updatedAt">> {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return { [field]: v };
  }
  if (typeof v === "string") {
    const ts = Date.parse(v);
    if (!Number.isNaN(ts)) return { [field]: new Date(ts) };
  }
  return {};
}
