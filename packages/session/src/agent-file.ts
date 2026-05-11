import { readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";

/**
 * Path to the agent persona file under a workdir. The provisioner is the one
 * that writes this file (copied verbatim from the catalog's agent dir).
 */
export const AGENT_FILE_NAME = "AGENTS.md";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Read the agent FQN (`<scope>/<name>`) from the YAML frontmatter of
 * `<workdir>/AGENTS.md`.
 *
 * The runtime writes AGENTS.md verbatim from the catalog (which uses
 * the spec frontmatter format: short `name` + optional `scope`). To
 * surface a value that matches what `CatalogManager.listAgents()`
 * returns, we recombine `scope/name` here. When `scope:` is omitted,
 * we use `public` — same default the catalog applies on install.
 *
 * Returns `null` if:
 *   - the file is missing or unreadable
 *   - it has no YAML frontmatter
 *   - the frontmatter doesn't parse, or doesn't contain a string `name`
 *
 * Never throws — callers `list()` over many dirs and skip those that fail.
 */
export async function readAgentName(workdir: string): Promise<string | null> {
  const file = path.join(workdir, AGENT_FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = yaml.load(match[1] ?? "");
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const name = obj.name;
  if (typeof name !== "string" || name.length === 0) return null;
  const scope = typeof obj.scope === "string" && obj.scope.length > 0 ? obj.scope : "public";
  return `${scope}/${name}`;
}
