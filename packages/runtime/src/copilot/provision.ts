import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentResolveResult, ResolvedMcp, ResolvedSkill } from "@emploke/catalog";
import { InvalidMcpJson, WorkspacePrepFailed } from "./errors.js";

const execFileAsync = promisify(execFile);

const DOT_DIR = ".github";
const MCP_CONFIG_PATH = ".mcp.json";
const COPILOT_SETTINGS_REL = path.join(".copilot", "settings.json");

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
 * Optional overrides for `provisionCopilotWorkdir`. Production callers
 * never pass these — they exist so unit tests can redirect side-effects
 * away from the developer's real home directory.
 */
export interface ProvisionCopilotOpts {
  /**
   * Absolute path to the Copilot CLI settings file we ensure trusts the
   * provisioned workdir. Defaults to `<homedir>/.copilot/settings.json`.
   * Tests pass a scratch path to avoid mutating the host's real settings.
   */
  copilotSettingsPath?: string;
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
 * Side-effect outside `workdir`: ensures `<homedir>/.copilot/settings.json`
 * lists `workdir` (or a parent of it) under `trustedFolders` so the spawned
 * Copilot CLI does not block on a per-folder trust prompt. See
 * `ensureWorkdirTrusted` for the merge semantics.
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
  opts: ProvisionCopilotOpts = {},
): Promise<void> {
  await mkdir(workdir, { recursive: true });
  await copyAgentFile(workdir, agent.agentPath);
  await writeMcpConfig(workdir, agent.mcps);
  await copySkills(workdir, agent.skills);
  await copyHooks(workdir, agent.skills);
  await prepareWorkspace(workdir, opts);
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

async function prepareWorkspace(workdir: string, opts: ProvisionCopilotOpts): Promise<void> {
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: workdir });
  } catch (cause) {
    throw new WorkspacePrepFailed("git init", workdir, cause as Error);
  }
  const settingsPath = opts.copilotSettingsPath ?? path.join(homedir(), COPILOT_SETTINGS_REL);
  await ensureWorkdirTrusted(workdir, settingsPath);
}

/**
 * Make sure `workdir` is covered by `<settingsPath>.trustedFolders` so that
 * the spawned Copilot CLI does not interrupt the user with a per-folder
 * trust prompt — the session UX assumes the terminal opens straight into
 * an interactive `copilot` session.
 *
 * Coverage rules (see `isPathCovered`):
 *   - exact match on the resolved absolute path counts as trusted
 *   - any ancestor directory listed in `trustedFolders` counts as trusted
 *     (e.g. trusting `~/.emploke` covers every session under it)
 *
 * If neither rule applies, the resolved workdir is appended verbatim and
 * the file is rewritten via temp+rename for atomicity. A missing or
 * unparseable settings file is treated as "start fresh"; we never refuse
 * to provision because the user's settings are corrupted, since that
 * would prevent the very first session on a new install from launching.
 */
async function ensureWorkdirTrusted(workdir: string, settingsPath: string): Promise<void> {
  const resolvedWorkdir = path.resolve(workdir);

  let settings: Record<string, unknown> = {};
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // ENOENT or invalid JSON — fall through with `settings = {}`. We
    // intentionally do NOT throw: a missing settings file is the normal
    // case before the user has launched Copilot CLI for the first time.
  }

  const existing = readTrustedFolders(settings.trustedFolders);
  if (isPathCovered(resolvedWorkdir, existing)) return;

  const next = [...existing, resolvedWorkdir];
  settings.trustedFolders = next;

  try {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const tmp = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(tmp, settingsPath);
  } catch (cause) {
    throw new WorkspacePrepFailed("trust workdir", settingsPath, cause as Error);
  }
}

/**
 * Coerce the raw `trustedFolders` value into a string array, dropping
 * non-string entries silently. We accept whatever shape the file currently
 * has (Copilot CLI may evolve the schema), but rewrite as plain `string[]`
 * since that is the documented and only-ever-observed format.
 */
function readTrustedFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === "string");
}

/**
 * Returns true iff `target` (an absolute path) is the same as, or nested
 * inside, any directory listed in `trusted`. Comparison happens on
 * `path.resolve`-d strings to normalise `..`, `.` and trailing separators.
 *
 * Boundary check uses `path.sep` so `/foo` does NOT cover `/foobar` (a bug
 * the naïve `startsWith` check would have).
 */
export function isPathCovered(target: string, trusted: readonly string[]): boolean {
  const normTarget = path.resolve(target);
  for (const entry of trusted) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    const normEntry = path.resolve(entry);
    if (normEntry === normTarget) return true;
    const prefix = normEntry.endsWith(path.sep) ? normEntry : normEntry + path.sep;
    if (normTarget.startsWith(prefix)) return true;
  }
  return false;
}
