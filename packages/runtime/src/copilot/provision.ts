import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";
import { InvalidMcpJson, WorkdirPrepFailed } from "./errors.js";

const execFileAsync = promisify(execFile);

const DOT_DIR = ".github";
const MCP_CONFIG_PATH = ".mcp.json";

/**
 * Separator used to flatten scoped names into single directory segments.
 *
 * Copilot scans `.github/skills/` for one-level entries containing
 * `SKILL.md`. A nested layout like `.github/skills/langsensei/weather/`
 * would be misread, so scoped skill names must be flattened.
 *
 * Double-underscore is unambiguous: catalog grammar is kebab-case
 * (`[a-z][a-z0-9]*(-[a-z0-9]+)*`), so `__` cannot appear in a valid name.
 */
const SCOPE_FLATTEN_SEP = "__";

/** Flatten `scope/name` into a single safe path segment. */
export function flattenSkillName(name: string): string {
  return name.replaceAll("/", SCOPE_FLATTEN_SEP);
}

/**
 * Bake `agent` into `workdir` so `copilot` can be launched there.
 *
 * Layout produced (relative to `workdir`):
 *
 *   AGENTS.md                       — copied verbatim from the resolved agent
 *   <agent siblings...>             — every other file the agent installed
 *   .mcp.json                       — `{ "mcpServers": { name: <parsed>, … } }`
 *   .github/skills/<name>/…         — each skill's content (excluding hooks/copilot/)
 *   .github/hooks/…                 — merged from each skill's hooks/copilot/
 *   .git/                           — empty repo (created by `git init`)
 *
 * Source data is pulled from the catalog as `AsyncIterable<{relPath, content}>`
 * streams (see {@link CatalogManager.skillEntries} /
 * {@link CatalogManager.agentEntries}). The runtime never resolves on-disk
 * catalog paths; a future SQLite-backed catalog implementation works the same
 * way.
 *
 * **Trust handling moved out**: previous versions of this function also
 * appended `workdir` to `~/.copilot/settings.json.trustedFolders`. That
 * concern is now `CopilotRuntime.registerWorkspace`, called once per
 * workspace at server bootstrap. Per-session provision no longer touches
 * the user's settings file.
 *
 * Idempotent in the trivial sense (re-running with the same inputs produces
 * the same files), but emploke's session manager always provisions into a
 * freshly-created empty workdir so we never rely on that.
 *
 * When two skills contribute files at the same relative path under
 * `.github/hooks/` or `.github/skills/<name>/`, the later one wins. Skill
 * order is the topological order the catalog produced.
 */
export async function provisionCopilotWorkdir(
  workdir: string,
  agent: AgentResolveResult,
  catalog: CatalogManager,
): Promise<void> {
  await mkdir(workdir, { recursive: true });
  await materializeAgent(workdir, agent.agent.name, catalog);
  await writeMcpConfig(workdir, agent.mcps, catalog);
  await materializeSkills(workdir, agent.skills, catalog);
  await initGitRepo(workdir);
}

/**
 * Copy every file the agent installed (AGENTS.md plus any sibling
 * templates / scripts) verbatim into `workdir`. The runtime treats agents
 * as multi-file entries — this is how operators bundle prompt fragments
 * or helper scripts alongside AGENTS.md.
 *
 * Hooks under the agent's own `hooks/copilot/` are merged into
 * `<workdir>/.github/hooks/` (same convention as skills) so an agent can
 * ship its own pretooluse / postresponse hooks.
 */
async function materializeAgent(
  workdir: string,
  agentName: string,
  catalog: CatalogManager,
): Promise<void> {
  const hooksDest = path.join(workdir, DOT_DIR, "hooks");
  let hooksDestReady = false;
  for await (const { relPath, content } of catalog.agentEntries(agentName)) {
    const hookRel = stripHooksPrefix(relPath);
    if (hookRel !== null) {
      if (!hooksDestReady) {
        await mkdir(hooksDest, { recursive: true });
        hooksDestReady = true;
      }
      await writeFileAt(hooksDest, hookRel, content);
    } else {
      await writeFileAt(workdir, relPath, content);
    }
  }
}

/**
 * For each MCP referenced by the agent's dependency graph, fetch its JSON
 * content from the catalog and merge into a single `<workdir>/.mcp.json`
 * keyed by MCP name. We don't reformat — the user's whitespace inside each
 * MCP's JSON is preserved.
 */
async function writeMcpConfig(
  workdir: string,
  mcps: readonly { readonly name: string }[],
  catalog: CatalogManager,
): Promise<void> {
  if (mcps.length === 0) return;

  const mcpServers: Record<string, unknown> = {};
  for (const mcp of mcps) {
    const raw = await catalog.getMcpContent(mcp.name);
    try {
      mcpServers[mcp.name] = JSON.parse(raw);
    } catch (cause) {
      throw new InvalidMcpJson(mcp.name, cause as Error);
    }
  }

  const dest = path.join(workdir, MCP_CONFIG_PATH);
  const json = `${JSON.stringify({ mcpServers }, null, 2)}\n`;
  await writeFile(dest, json, "utf8");
}

/**
 * For each resolved skill, pull its file stream from the catalog and write
 * into `<workdir>/.github/skills/<flattenedName>/`. Skill-internal
 * `hooks/copilot/` files are diverted to `<workdir>/.github/hooks/`
 * (Copilot's hook discovery only looks there).
 */
async function materializeSkills(
  workdir: string,
  skills: readonly { readonly skill: { readonly name: string } }[],
  catalog: CatalogManager,
): Promise<void> {
  const skillsRoot = path.join(workdir, DOT_DIR, "skills");
  const hooksDest = path.join(workdir, DOT_DIR, "hooks");
  let hooksDestReady = false;

  for (const s of skills) {
    const skillDest = path.join(skillsRoot, flattenSkillName(s.skill.name));
    await mkdir(skillDest, { recursive: true });
    for await (const { relPath, content } of catalog.skillEntries(s.skill.name)) {
      const hookRel = stripHooksPrefix(relPath);
      if (hookRel !== null) {
        if (!hooksDestReady) {
          await mkdir(hooksDest, { recursive: true });
          hooksDestReady = true;
        }
        await writeFileAt(hooksDest, hookRel, content);
      } else {
        await writeFileAt(skillDest, relPath, content);
      }
    }
  }
}

/**
 * If `relPath` begins with `hooks/copilot/`, return the path relative to
 * that prefix (so `hooks/copilot/preToolUse.js` -> `preToolUse.js`). The
 * catalog yields posix-style separators; we match accordingly.
 *
 * Returns `null` for any path that doesn't belong under hooks — those go
 * to the entry root.
 */
function stripHooksPrefix(relPath: string): string | null {
  const PREFIX = "hooks/copilot/";
  if (!relPath.startsWith(PREFIX)) return null;
  const rest = relPath.slice(PREFIX.length);
  return rest === "" ? null : rest;
}

/**
 * Write `content` to `<destRoot>/<relPath>`, creating intermediate
 * directories. `relPath` is POSIX-style (the catalog contract); we split
 * on `/` and re-join via `path.join` so it materializes correctly on
 * Windows too.
 */
async function writeFileAt(destRoot: string, relPath: string, content: Buffer): Promise<void> {
  const segments = relPath.split("/");
  const fileName = segments.pop();
  if (!fileName) return;
  const dir = segments.length > 0 ? path.join(destRoot, ...segments) : destRoot;
  if (segments.length > 0) await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), content);
}

async function initGitRepo(workdir: string): Promise<void> {
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: workdir });
  } catch (cause) {
    throw new WorkdirPrepFailed("git init", workdir, cause as Error);
  }
}
