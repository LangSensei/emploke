import yaml from "js-yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/**
 * Apply a partial patch to the YAML frontmatter of a markdown document
 * (e.g. SKILL.md / AGENTS.md / any `---`-delimited front-matter file).
 *
 * Pure function; no I/O. Used by:
 *   - `@emploke/catalog` to edit installed skill/agent metadata
 *   - `@emploke/runtime` to rewrite the `name` field when projecting
 *     a skill into a session workdir so it matches the (flattened)
 *     on-disk folder name target CLIs expect
 *
 * Behavior:
 *   - Body bytes preserved verbatim (only the YAML block changes).
 *   - Patch keys with `null` / `undefined` value REMOVE the key.
 *   - All other patch values overwrite. Existing frontmatter keys
 *     not in the patch are preserved.
 *   - Output: `---\n<yaml>\n---\n<body>` with canonical YAML
 *     (no anchors, single-line scalars). YAML comments and original
 *     key order are NOT preserved (js-yaml round-trip limitation).
 */
export function applyFrontmatterPatch(raw: string, patch: Record<string, unknown>): string {
  const match = raw.match(FRONTMATTER_RE);
  let existing: Record<string, unknown> = {};
  let body = raw;
  if (match) {
    let parsed: unknown;
    try {
      parsed = yaml.load(match[1] ?? "");
    } catch {
      // Unparseable frontmatter — replace the whole block.
      parsed = {};
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
    body = raw.slice(match[0].length);
  }

  const merged: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) {
      delete merged[k];
    } else {
      merged[k] = v;
    }
  }

  const yamlText = yaml.dump(merged, { lineWidth: -1, noRefs: true }).trimEnd();
  return `---\n${yamlText}\n---\n${body}`;
}
