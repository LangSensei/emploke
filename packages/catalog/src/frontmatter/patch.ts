import yaml from "js-yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/**
 * Apply a partial patch to the frontmatter of a raw markdown document
 * (SKILL.md / AGENTS.md). Used by:
 *   - `CatalogManager.updateSkillMetadata` / `updateAgentMetadata`
 *     (HTTP PATCH on `/skills/:name`, `/agents/:name`)
 *   - The runtime, when materialising a skill into a session workdir,
 *     to rewrite the `name` field on the workdir-side projection
 *     (avoids Copilot CLI's same-name dedup).
 *
 * Behavior:
 *   - Body bytes preserved verbatim (only the YAML block changes).
 *   - Patch keys that are `null` or `undefined` REMOVE the key.
 *   - All other patch values overwrite. Existing frontmatter keys
 *     not in the patch are preserved.
 *   - Output: `---\n<yaml>\n---\n<body>` with the YAML serialised
 *     in canonical form (no anchors, single-line scalars).
 *
 * Limitations: YAML comments and original key order are NOT preserved
 * (round-trip limitation of js-yaml). Most md-frontmatter tools have
 * the same behavior.
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
      // Existing frontmatter unparseable; replace it whole.
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
