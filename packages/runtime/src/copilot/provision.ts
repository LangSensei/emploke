import { execFile } from "node:child_process";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentResolveResult, ResolvedMcp, ResolvedSkill } from "@emploke/catalog";
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
 *   .mcp.json                       — `{ "mcpServers": { name: <parsed>, … } }`
 *   .github/skills/<name>/…         — each skill's content (excluding hooks/)
 *   .github/hooks/…                 — merged from each skill's hooks/copilot/
 *   .git/                           — empty repo (created by `git init`)
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
): Promise<void> {
  await mkdir(workdir, { recursive: true });
  await copyAgentFile(workdir, agent.agentPath);
  await writeMcpConfig(workdir, agent.mcps);
  await copySkills(workdir, agent.skills);
  await copyHooks(workdir, agent.skills);
  await initGitRepo(workdir);
}

async function copyAgentFile(workdir: string, agentPath: string): Promise<void> {
  const src = path.join(agentPath, "AGENTS.md");
  const dest = path.join(workdir, "AGENTS.md");
  await cp(src, dest, { force: true });
}

async function writeMcpConfig(workdir: string, mcps: readonly ResolvedMcp[]): Promise<void> {
  if (mcps.length === 0) return;

  const mcpServers: Record<string, unknown> = {};
  for (const mcp of mcps) {
    const raw = await readFile(mcp.path, "utf8");
    try {
      mcpServers[mcp.name] = JSON.parse(raw);
    } catch (cause) {
      throw new InvalidMcpJson(mcp.name, mcp.path, cause as Error);
    }
  }

  const dest = path.join(workdir, MCP_CONFIG_PATH);
  const json = `${JSON.stringify({ mcpServers }, null, 2)}\n`;
  await writeFile(dest, json, "utf8");
}

async function copySkills(workdir: string, skills: readonly ResolvedSkill[]): Promise<void> {
  const skillsRoot = path.join(workdir, DOT_DIR, "skills");
  for (const s of skills) {
    const dest = path.join(skillsRoot, flattenSkillName(s.skill.name));
    const hooksPath = path.join(s.path, "hooks");
    await mkdir(dest, { recursive: true });
    await cp(s.path, dest, {
      recursive: true,
      force: true,
      // Exclude only the top-level `hooks/` subdir of THIS skill. Anything
      // else (SKILL.md, nested assets, deep dirs called "hooks" inside other
      // subtrees) is preserved.
      filter: (src) => src !== hooksPath && !src.startsWith(hooksPath + path.sep),
    });
  }
}

async function copyHooks(workdir: string, skills: readonly ResolvedSkill[]): Promise<void> {
  const hooksDest = path.join(workdir, DOT_DIR, "hooks");
  let destReady = false;

  for (const s of skills) {
    const src = path.join(s.path, "hooks", "copilot");
    try {
      const info = await stat(src);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }
    if (!destReady) {
      await mkdir(hooksDest, { recursive: true });
      destReady = true;
    }
    await cp(src, hooksDest, { recursive: true, force: true });
  }
}

async function initGitRepo(workdir: string): Promise<void> {
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: workdir });
  } catch (cause) {
    throw new WorkdirPrepFailed("git init", workdir, cause as Error);
  }
}
