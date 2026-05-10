import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DependencyRef } from "../src/types.js";

/**
 * Test helpers for the post-#39 catalog. Centralised because every test
 * file otherwise duplicates the same `makeSkillSource` / `makeAgentSource`
 * scaffolding, and the FQN migration changed the contract for all of them.
 *
 * Conventions:
 *  - `name` is the SHORT name authored in the frontmatter (kebab-case, no
 *    `/`). Tests should NEVER write `name: "scope/foo"` — instead set
 *    `scope: "scope"` separately and let the test helpers compute the FQN.
 *  - `scope` is optional — when absent the install will pick `local` from
 *    the synthetic `file:<sourcePath>` origin. Tests that need an
 *    explicit scope (e.g. for graphNodes assertions) pass it.
 *  - `deps` accept either short-form `[{name, originHint}, ...]` or
 *    helper-produced refs via `dep("foo")`. The helper synthesises a
 *    `file:` origin so the resulting FQN resolves to `local/foo`.
 */

/** Compute the FQN for a fixture that omits `scope:`. Always `public/<name>`. */
export function localFqn(shortName: string): string {
  return `public/${shortName}`;
}

/** Build a {@link DependencyRef} for a SKILL dep installed as `public/<short>`. */
export function dep(shortName: string, scope = "public"): DependencyRef {
  // Use a synthetic file: URI; parseOrigin accepts any non-empty path.
  // Distinct per-call so the URI uniquely identifies the dep target
  // (the recursive installer wouldn't actually fetch anything in tests).
  return { name: shortName, origin: `file:/test/${scope}/${shortName}`, scope };
}

/**
 * Build a {@link DependencyRef} for an MCP dep. The `name` is the full
 * MCP-spec FQN (`<namespace>/<short>`, e.g. `azure/mcp`); MCPs don't
 * participate in scope-mapping.
 */
export function mcpDep(specName: string): DependencyRef {
  return { name: specName, origin: `file:/test/mcps/${specName.replace("/", "_")}.json` };
}

export interface MakeSourceOpts {
  description?: string;
  version?: string;
  scope?: string;
  origin?: string;
  deps?: { skills?: DependencyRef[]; mcps?: DependencyRef[] };
  prereqs?: string;
}

function frontmatterLines(name: string, opts: MakeSourceOpts, kindHint: string): string[] {
  const lines: string[] = ["---", `name: ${name}`];
  if (opts.scope !== undefined) lines.push(`scope: ${opts.scope}`);
  if (opts.origin !== undefined) lines.push(`origin: ${opts.origin}`);
  lines.push(`description: ${opts.description ?? `${kindHint} ${name}`}`);
  if (opts.version !== undefined) lines.push(`version: ${opts.version}`);
  if (opts.deps) {
    lines.push("dependencies:");
    if (opts.deps.skills && opts.deps.skills.length > 0) {
      lines.push("  skills:");
      for (const ref of opts.deps.skills) {
        lines.push(`    - name: ${ref.name}`);
        lines.push(`      origin: ${ref.origin}`);
        if (ref.scope !== undefined) lines.push(`      scope: ${ref.scope}`);
      }
    }
    if (opts.deps.mcps && opts.deps.mcps.length > 0) {
      lines.push("  mcps:");
      for (const ref of opts.deps.mcps) {
        lines.push(`    - name: ${ref.name}`);
        lines.push(`      origin: ${ref.origin}`);
        if (ref.scope !== undefined) lines.push(`      scope: ${ref.scope}`);
      }
    }
  }
  if (opts.prereqs !== undefined) lines.push(`prereqs: "${opts.prereqs}"`);
  lines.push("---", "", "## Instructions", "Do stuff.");
  return lines;
}

/**
 * Create a SKILL.md source directory under `sourceDir`. Returns the dir.
 * The frontmatter `name` is the SHORT name (post-#39); pass `scope` for
 * non-`local` scope.
 *
 * The dir name is derived from the short name (no random suffix), so
 * calling `makeSkillSource(sourceDir, "weather")` twice deliberately
 * returns the same path. That way upsert tests can re-install from the
 * "same source" and the synthesised `file:` origin matches across both
 * calls — otherwise {@link OriginConflictError} would (correctly) trip.
 */
export async function makeSkillSource(
  sourceDir: string,
  shortName: string,
  opts: MakeSourceOpts = {},
): Promise<string> {
  const dir = join(sourceDir, shortName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), frontmatterLines(shortName, opts, "Skill").join("\n"));
  return dir;
}

/** Create an AGENTS.md source directory; same shape as {@link makeSkillSource}. */
export async function makeAgentSource(
  sourceDir: string,
  shortName: string,
  opts: MakeSourceOpts = {},
): Promise<string> {
  const dir = join(sourceDir, `agent-${shortName}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "AGENTS.md"), frontmatterLines(shortName, opts, "Agent").join("\n"));
  return dir;
}

/** Create an MCP JSON source file under `sourceDir`. */
export async function makeMcpSource(
  sourceDir: string,
  shortName: string,
  content?: object,
): Promise<string> {
  const file = join(sourceDir, `${shortName}.json`);
  await writeFile(
    file,
    JSON.stringify(content ?? { type: "stdio", command: "npx", args: [`@mcp/${shortName}`] }),
  );
  return file;
}

/** Allocate a fresh tmp base dir for a test. */
export function makeBase(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}
