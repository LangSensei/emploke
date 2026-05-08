import { readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";

/**
 * Best-effort summary of one copilot session, parsed from its
 * `workspace.yaml`. All fields are optional except `runtimeSessionId`.
 */
export interface CopilotSessionState {
  /** Same UUID we used as the lookup key (echoed for caller convenience). */
  readonly runtimeSessionId: string;
  /** ISO string from `updated_at`, falling back to `created_at` if missing. */
  readonly lastActiveAt: string;
  /** Short user-facing label: `summary` if present, else `name`, else null. */
  readonly preview: string | null;
}

/**
 * Read a single copilot session's state by id. Returns `null` if:
 *
 *   - the directory doesn't exist (user hasn't launched copilot yet)
 *   - the directory exists but has no readable `workspace.yaml`
 *   - the file exists but is malformed
 *   - no usable timestamp can be derived
 *
 * Never throws — callers (`Runtime.refresh`) treat null as "no activity yet".
 *
 * Unlike the previous design, this does NOT scan all sessions or build a cwd
 * index. Each emploke session knows its copilot session id directly (we
 * pre-allocate it at provision time and persist it in `session.json`), so
 * lookup is a single direct file read.
 */
export async function readCopilotSessionState(
  copilotStateDir: string,
  runtimeSessionId: string,
): Promise<CopilotSessionState | null> {
  const yamlPath = path.join(copilotStateDir, runtimeSessionId, "workspace.yaml");
  let raw: string;
  try {
    raw = await readFile(yamlPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const updatedAt = parseIsoLike(obj.updated_at);
  const createdAt = parseIsoLike(obj.created_at);
  const lastActiveAt = updatedAt ?? createdAt;
  if (lastActiveAt === null) return null;

  const summary = typeof obj.summary === "string" && obj.summary.length > 0 ? obj.summary : null;
  const name = typeof obj.name === "string" && obj.name.length > 0 ? obj.name : null;
  const preview = summary ?? name;

  return { runtimeSessionId, lastActiveAt, preview };
}

/**
 * Parse a value into an ISO 8601 string. Accepts:
 *   - `Date` (yaml's auto-parsing produces these for ISO timestamps)
 *   - parseable date strings
 * Returns null otherwise.
 */
function parseIsoLike(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString();
  }
  if (typeof v === "string") {
    const ts = Date.parse(v);
    if (!Number.isNaN(ts)) return new Date(ts).toISOString();
  }
  return null;
}
