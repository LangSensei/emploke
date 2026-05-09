/**
 * MCP "frontmatter" — the inline `_meta: { name, origin }` block we
 * stash inside each MCP's JSON content.
 *
 * Why inline rather than a sidecar file:
 *  - keeps the catalog's MCP storage single-file (matches Phase 1 dev
 *    intuition; one `mcps/<ns>/<short>.json` per MCP, full stop).
 *  - survives copy-paste between catalogs / git repos without
 *    additional bookkeeping (the JSON file IS the entry).
 *  - aligns with the MCP registry's convention (`_meta.<reverse-dns>`
 *    namespaced sub-objects). We add only `_meta.name` + `_meta.origin`
 *    at the top level — both flat strings, no `io.emploke` namespace
 *    wrapper, since this file is internal-only and we don't need the
 *    spec's namespace-collision protection.
 *
 * Merge-preserve rule: if the input MCP content already carries a
 * `_meta` block (e.g. from `registry.modelcontextprotocol.io` content
 * that ships with `_meta.io.modelcontextprotocol.registry/...`),
 * {@link writeMeta} preserves the existing keys and only adds /
 * overwrites the top-level `name` + `origin` keys. Reverse-DNS
 * namespaced sub-objects survive untouched.
 *
 * Provision strip: the runtime strips the ENTIRE `_meta` key (not
 * selective) before writing into a session's `.mcp.json`. Copilot CLI
 * shouldn't see ANY metadata when running the MCP.
 */
import { InvalidMcpJsonError } from "../errors.js";

export interface McpMeta {
  readonly name: string;
  readonly origin: string;
}

export interface McpFileShape {
  readonly meta: McpMeta;
  /** The full parsed JSON object (including the `_meta` block). */
  readonly raw: Record<string, unknown>;
}

/**
 * Parse a raw MCP file body. Returns the typed `_meta` block plus the
 * full parsed object so callers can preserve user-formatted client
 * shape (`command`/`args`/`env`/...).
 *
 * Throws {@link InvalidMcpJsonError} on:
 *  - JSON parse failure
 *  - top-level value not an object
 *  - missing or non-string `_meta.name`
 *  - missing or non-string `_meta.origin`
 */
export function parseMcpFile(content: string, sourcePath: string): McpFileShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw new InvalidMcpJsonError(sourcePath, (cause as Error).message, { cause });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidMcpJsonError(sourcePath, "MCP file must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const metaRaw = obj._meta;
  if (
    metaRaw === undefined ||
    metaRaw === null ||
    typeof metaRaw !== "object" ||
    Array.isArray(metaRaw)
  ) {
    throw new InvalidMcpJsonError(
      sourcePath,
      "MCP file must include a `_meta` object with `name` and `origin`",
    );
  }
  const meta = metaRaw as Record<string, unknown>;
  if (typeof meta.name !== "string" || meta.name.length === 0) {
    throw new InvalidMcpJsonError(sourcePath, "`_meta.name` must be a non-empty string");
  }
  if (typeof meta.origin !== "string" || meta.origin.length === 0) {
    throw new InvalidMcpJsonError(sourcePath, "`_meta.origin` must be a non-empty string");
  }
  return { meta: { name: meta.name, origin: meta.origin }, raw: obj };
}

/**
 * Insert / update emploke's `_meta.{name, origin}` keys into an MCP
 * file body without disturbing the rest of the JSON.
 *
 * Behavior:
 *  - If `content` is an empty/whitespace-only string, return a fresh
 *    `{ "_meta": { name, origin } }` object (used when the route layer
 *    only has the meta and no client shape — uncommon, but supported).
 *  - If `content` parses to a JSON object without `_meta`, add `_meta`
 *    with the two keys.
 *  - If `content` carries an existing `_meta` (e.g., MCP-registry
 *    namespaced sub-objects), shallow-merge: emploke's `name` and
 *    `origin` overwrite, all other top-level keys inside `_meta` (incl.
 *    reverse-DNS namespaced sub-objects) survive untouched.
 *  - Output is `JSON.stringify(..., null, 2)` with a trailing newline.
 *    User-authored whitespace inside the original content is NOT
 *    preserved (round-trip via parse/stringify is unavoidable when
 *    we have to mutate `_meta`).
 *
 * Throws {@link InvalidMcpJsonError} if the input doesn't parse or
 * isn't an object.
 */
export function writeMcpMeta(content: string, meta: McpMeta, sourcePath: string): string {
  let body: Record<string, unknown>;
  if (content.trim().length === 0) {
    body = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (cause) {
      throw new InvalidMcpJsonError(sourcePath, (cause as Error).message, { cause });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new InvalidMcpJsonError(sourcePath, "MCP file must be a JSON object");
    }
    body = parsed as Record<string, unknown>;
  }
  const existingMeta = body._meta;
  const mergedMeta: Record<string, unknown> =
    existingMeta !== null && typeof existingMeta === "object" && !Array.isArray(existingMeta)
      ? { ...(existingMeta as Record<string, unknown>) }
      : {};
  mergedMeta.name = meta.name;
  mergedMeta.origin = meta.origin;
  const out: Record<string, unknown> = { ...body, _meta: mergedMeta };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Strip the entire `_meta` key from an MCP file body. Used by the
 * runtime when materializing `.mcp.json` — Copilot CLI never sees
 * emploke's metadata.
 *
 * Returns the stripped JSON as a pretty-printed string. If the input
 * has no `_meta`, returns the re-serialized body (still safe for the
 * runtime; we never write the original bytes verbatim because we may
 * be aggregating multiple MCPs into one .mcp.json).
 *
 * Throws {@link InvalidMcpJsonError} if the input is not a JSON object.
 */
export function stripMcpMeta(content: string, sourcePath: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw new InvalidMcpJsonError(sourcePath, (cause as Error).message, { cause });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidMcpJsonError(sourcePath, "MCP file must be a JSON object");
  }
  const { _meta: _drop, ...rest } = parsed as Record<string, unknown>;
  return rest;
}
