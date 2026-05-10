import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EntryFile, FileFetcher } from "@emploke/catalog-fetcher";
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
 *  - `scope` is optional — when absent the FQN resolves to `public/<name>`
 *    (the catalog's default scope when frontmatter omits `scope:`).
 *  - `deps` accept either short-form `[{name, originHint}, ...]` or
 *    helper-produced refs via `dep("foo")`. The helper synthesises a
 *    `file:` origin so the resulting FQN resolves to `public/foo`.
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

const FILE_FETCHER = new FileFetcher();

/**
 * Convert a local source dir to an `EntryFile` stream + the canonical
 * `file:<dir>` origin URI. Use this when a test wants to install from
 * a dir built via `makeSkillSource` / `makeAgentSource` — catalog only
 * accepts streams now (no more `installFromDir`).
 */
export function streamFromDir(dir: string): {
  stream: AsyncIterable<EntryFile>;
  origin: string;
} {
  const origin = `file:${dir}`;
  return { stream: FILE_FETCHER.fetch(origin), origin };
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

/**
 * Convenience: install an entry from a local directory into a store
 * that takes a stream + opts. Wraps {@link streamFromDir}.
 *
 * Works for `SkillCatalog`, `AgentCatalog`, and `CatalogManager`'s
 * `installSkill` / `installAgent` (they share the
 * `(stream, { origin }, label?) → Promise<T>` shape).
 */
export async function installFromDir<T>(
  store: {
    install(stream: AsyncIterable<EntryFile>, opts: { origin: string }, label?: string): Promise<T>;
  },
  dir: string,
): Promise<T> {
  const { stream, origin } = streamFromDir(dir);
  return store.install(stream, { origin }, origin);
}

/**
 * Convenience: install a skill into a CatalogManager from a local
 * dir. Wraps streamFromDir.
 */
export async function installCatalogSkillFromDir<
  C extends {
    installSkill(
      stream: AsyncIterable<EntryFile>,
      opts: { origin: string },
      label?: string,
    ): Promise<unknown>;
  },
>(c: C, dir: string) {
  const { stream, origin } = streamFromDir(dir);
  return c.installSkill(stream, { origin }, origin);
}

/** Convenience: install an agent into a CatalogManager from a local dir. */
export async function installCatalogAgentFromDir<
  C extends {
    installAgent(
      stream: AsyncIterable<EntryFile>,
      opts: { origin: string },
      label?: string,
    ): Promise<unknown>;
  },
>(c: C, dir: string) {
  const { stream, origin } = streamFromDir(dir);
  return c.installAgent(stream, { origin }, origin);
}

/**
 * Convenience: install a Repository entry from a local dir, by
 * wrapping FileFetcher's stream. Used by FsRepository tests that
 * previously called repo.installFromDir directly.
 */
export async function installRepoFromDir<
  R extends { install(name: string, stream: AsyncIterable<EntryFile>): Promise<void> },
>(repo: R, name: string, dir: string): Promise<void> {
  const { stream } = streamFromDir(dir);
  await repo.install(name, stream);
}
