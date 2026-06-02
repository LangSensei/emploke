import { createHash } from "node:crypto";
import { McpInvalidJsonError } from "./errors.js";

/**
 * MCP file format codec — pure, side-effect-free, I/O-free.
 *
 * Single responsibility: convert between raw JSON bytes and a typed
 * `{ meta, body }` view. No knowledge of storage, no validation of
 * business rules (e.g., name format), no parsing of dependency trees.
 *
 * The format itself is fixed by the MCP spec convention: an MCP
 * client-config JSON object that may carry a top-level `_meta` block
 * for arbitrary metadata. Emploke claims a single reserved key inside
 * `_meta`:
 *
 *   - `_meta.name` — full MCP spec FQN (`<namespace>/<short>`).
 *     Authors must declare it; emploke needs it to derive the FQN
 *     when the dep ref is origin-only.
 *
 * Origin (install-source URI) is NOT carried in `_meta`. It's known
 * at install time as the fetch URI and persisted on the SQLite row
 * directly. Files in the wild that happen to carry `_meta.origin`
 * (e.g. from third-party tooling that treats `_meta` as a free-form
 * metadata bag) are tolerated: parse ignores the field,
 * {@link writeMeta} preserves it untouched alongside other foreign
 * keys, and {@link contentDigestExcludingMeta} strips the whole
 * `_meta` block so it never affects equality.
 *
 * Any other `_meta.*` keys (e.g., reverse-DNS namespaced sub-objects
 * from `registry.modelcontextprotocol.io`) survive untouched through
 * the merge in {@link writeMeta}.
 */

export interface McpMeta {
  readonly name: string;
}

export interface McpFile {
  readonly meta: McpMeta;
  /** The full parsed JSON object, including the `_meta` block. */
  readonly body: Record<string, unknown>;
}

/**
 * Parse raw MCP file bytes into a typed `{ meta, body }` view.
 *
 * Throws {@link McpInvalidJsonError} on:
 *   - JSON parse failure
 *   - top-level value not an object (array / null / primitive)
 *   - missing or non-string `_meta.name`
 *
 * `_meta.origin` is intentionally NOT validated — origin is an
 * install-time fact (the URI we fetched from), not part of the file's
 * declarative contract. Files that carry it pass through unchanged.
 *
 * `sourceLabel` is included verbatim in error messages — pass an
 * on-disk path, a synthetic label like `mcps:azure/mcp`, or `<request>`
 * for HTTP body parse errors.
 */
export function parse(content: string, sourceLabel: string): McpFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw new McpInvalidJsonError(sourceLabel, (cause as Error).message, { cause });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new McpInvalidJsonError(sourceLabel, "MCP file must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const metaRaw = obj._meta;
  if (
    metaRaw === undefined ||
    metaRaw === null ||
    typeof metaRaw !== "object" ||
    Array.isArray(metaRaw)
  ) {
    throw new McpInvalidJsonError(
      sourceLabel,
      "MCP file must include a `_meta` object with a `name` field",
    );
  }
  const meta = metaRaw as Record<string, unknown>;
  if (typeof meta.name !== "string" || meta.name.length === 0) {
    throw new McpInvalidJsonError(sourceLabel, "`_meta.name` must be a non-empty string");
  }
  return { meta: { name: meta.name }, body: obj };
}

/**
 * Insert / update emploke's `_meta.name` key in MCP file bytes
 * without disturbing the rest of the JSON.
 *
 * Behavior:
 *  - empty / whitespace-only input → returns a fresh
 *    `{ "_meta": { name } }` object
 *  - object with no `_meta` → adds a `_meta` block with `name`
 *  - object with existing `_meta` (e.g., MCP-registry sub-objects,
 *    a pre-existing `_meta.origin`) → shallow-merges: emploke's
 *    `name` overwrites, all other top-level keys inside `_meta`
 *    survive untouched
 *  - output is `JSON.stringify(..., null, 2)` with a trailing newline
 *
 * Origin is NOT written: the install-time URI lives in the SQLite
 * `origin` column, not in the file. Authors don't write it; we
 * don't stamp it.
 *
 * User-authored whitespace inside the input is NOT preserved (a
 * round-trip through parse/stringify is unavoidable when mutating
 * `_meta`). This is acceptable for client-config JSON, which is
 * machine-edited at install time.
 *
 * Throws {@link McpInvalidJsonError} if the input doesn't parse or
 * isn't a JSON object.
 */
export function writeMeta(content: string, meta: McpMeta, sourceLabel: string): string {
  let body: Record<string, unknown>;
  if (content.trim().length === 0) {
    body = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (cause) {
      throw new McpInvalidJsonError(sourceLabel, (cause as Error).message, { cause });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new McpInvalidJsonError(sourceLabel, "MCP file must be a JSON object");
    }
    body = parsed as Record<string, unknown>;
  }
  const existingMeta = body._meta;
  const mergedMeta: Record<string, unknown> =
    existingMeta !== null && typeof existingMeta === "object" && !Array.isArray(existingMeta)
      ? { ...(existingMeta as Record<string, unknown>) }
      : {};
  mergedMeta.name = meta.name;
  const out: Record<string, unknown> = { ...body, _meta: mergedMeta };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Strip the entire `_meta` key from MCP file bytes. Used by runtime
 * adapters when materializing the MCP client-config file (typically
 * `.mcp.json`) for a downstream MCP host; the downstream host should
 * never see emploke's `_meta` block.
 *
 * Returns the stripped object as a plain JS value (caller decides
 * whether to re-stringify). Throws {@link McpInvalidJsonError} if the
 * input is not a JSON object.
 */
export function stripMeta(content: string, sourceLabel: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw new McpInvalidJsonError(sourceLabel, (cause as Error).message, { cause });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new McpInvalidJsonError(sourceLabel, "MCP file must be a JSON object");
  }
  const { _meta: _drop, ...rest } = parsed as Record<string, unknown>;
  return rest;
}

/**
 * Canonical SHA-256 digest of the MCP content with `_meta` stripped.
 *
 * Used by the sync resolve path to detect "no upstream change". We
 * deliberately strip the entire `_meta` block so install-time
 * additions (emploke writes `_meta.name`, registry tooling may add
 * its own sub-objects, `_meta.origin` may already be present on the
 * upstream file) don't show up as spurious diffs against pristine
 * upstream bytes.
 *
 * `null` if the content is unparseable; callers treat that as "always
 * different" so a parse-failed upstream still falls into the will-sync
 * branch (and surfaces its parse error properly).
 */
export function contentDigestExcludingMeta(content: string, sourceLabel: string): string | null {
  let stripped: Record<string, unknown>;
  try {
    stripped = stripMeta(content, sourceLabel);
  } catch {
    return null;
  }
  const canonical = JSON.stringify(canonicalise(stripped));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function canonicalise(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      const v = obj[k];
      if (v !== undefined) out[k] = canonicalise(v);
    }
    return out;
  }
  return value;
}
