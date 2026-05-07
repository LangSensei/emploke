import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionMarker } from "./types.js";

/** Path under workdir where the marker lives. */
export const MARKER_DIR = ".emploke";
export const MARKER_FILE = "session.json";

/** Compute the absolute marker file path for a workdir. */
export function markerPathFor(workdir: string): string {
  return path.join(workdir, MARKER_DIR, MARKER_FILE);
}

/**
 * Atomically write the marker file. Writes to `<file>.tmp` first, then renames.
 * Caller is responsible for ensuring the parent workdir exists; this function
 * mkdirs `.emploke/` itself.
 */
export async function writeMarker(workdir: string, marker: SessionMarker): Promise<void> {
  const dir = path.join(workdir, MARKER_DIR);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, MARKER_FILE);
  const tmp = `${file}.tmp`;
  const body = `${JSON.stringify(marker, null, 2)}\n`;
  await writeFile(tmp, body, { encoding: "utf8" });
  await rename(tmp, file);
}

/**
 * Read and validate the marker file. Returns null if the file is missing,
 * malformed JSON, or fails schema checks. Never throws — callers iterate and
 * silently skip invalid markers.
 */
export async function readMarker(workdir: string): Promise<SessionMarker | null> {
  const file = markerPathFor(workdir);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) return null;
  if (typeof obj.agent !== "string" || obj.agent.length === 0) return null;
  if (typeof obj.createdAt !== "string") return null;
  // Validate createdAt is a parseable ISO date.
  const ts = Date.parse(obj.createdAt);
  if (Number.isNaN(ts)) return null;
  const catalogDirRaw = obj.catalogDir;
  const marker: SessionMarker = {
    version: 1,
    agent: obj.agent,
    createdAt: obj.createdAt,
    ...(typeof catalogDirRaw === "string" ? { catalogDir: catalogDirRaw } : {}),
  };
  return marker;
}
