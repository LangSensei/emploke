import { execFile } from "node:child_process";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import type { ResolvedMcp, ResolvedSkill } from "@emploke/catalog";
import { InvalidMcpJson, WorkspacePrepFailed } from "./errors.js";
import type { Provisioner, ProvisionParams } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Per-provider configuration for Copilot. Kept inline rather than abstracted
 * into a base class — when a second provider lands we'll know what's truly
 * shared and can extract the abstraction with evidence rather than guesswork.
 */
const DOT_DIR = ".github";
const MCP_CONFIG_PATH = ".mcp.json";

/**
 * Separator used to flatten scoped names into single directory segments.
 *
 * The Copilot CLI scans `.github/skills/` for one-level entries containing
 * `SKILL.md`. A nested layout like `.github/skills/langsensei/weather/` would
 * be misread (Copilot would look for `.github/skills/langsensei/SKILL.md`),
 * so scoped skill names must be flattened.
 *
 * Double-underscore is chosen because it cannot occur in a valid skill name
 * (catalog grammar is kebab-case: `[a-z][a-z0-9]*(-[a-z0-9]+)*`), making the
 * mapping unambiguous and reversible via `split("__")`.
 *
 * Examples:
 *   "weather"             → "weather"
 *   "langsensei/weather"  → "langsensei__weather"
 *   "io.playwright/mcp"   → "io.playwright__mcp"
 */
const SCOPE_FLATTEN_SEP = "__";

/**
 * Flattens a (possibly scoped) skill name into a single path segment safe for
 * one-level directory scanners.
 */
export function flattenSkillName(name: string): string {
  return name.replaceAll("/", SCOPE_FLATTEN_SEP);
}

/**
 * CopilotProvisioner composes a workspace directory for the GitHub Copilot
 * CLI. Layout produced (relative to `targetDir`):
 *
 *     AGENTS.md                       — copied verbatim from the resolved
 *                                       agent entry (catalog source of truth)
 *     .mcp.json                       — { "mcpServers": { name: <parsed>, … } }
 *     .github/skills/<name>/…         — each skill's content (excluding hooks/)
 *     .github/hooks/…                 — merged from each skill's hooks/copilot/
 *     .git/                           — empty repo (created by `git init`)
 *
 * Provisioner is responsible for **environment-level** provisioning, which
 * includes the agent's persona file (`AGENTS.md`). It does NOT compose or
 * append per-task instructions: those are passed to the CLI by the runtime
 * (e.g. `copilot -p "<task prompt>"`). This split lets the same workdir
 * serve many tasks against the same agent without re-provisioning.
 *
 * The execution unit is always an agent — provisioner accepts only an
 * `AgentResolveResult`. A skill alone cannot be provisioned for execution:
 * if you want to dispatch a single skill, wrap it in an agent.
 *
 * Skills are composed in the topological order provided by the resolve
 * result. When two skills contribute files with the same path under
 * `.github/hooks/` or `.github/skills/<name>/`, the later one wins (silent
 * overwrite). This matches the SWAT convention.
 */
export class CopilotProvisioner implements Provisioner {
  readonly name = "copilot";

  async provision(params: ProvisionParams): Promise<void> {
    const { resolveResult, targetDir } = params;

    await mkdir(targetDir, { recursive: true });
    await this.copyAgentFile(targetDir, resolveResult.agentPath);
    await this.writeMcpConfig(targetDir, resolveResult.mcps);
    await this.copySkills(targetDir, resolveResult.skills);
    await this.copyHooks(targetDir, resolveResult.skills);
    await this.prepareWorkspace(targetDir);
  }

  private async copyAgentFile(targetDir: string, agentPath: string): Promise<void> {
    const src = join(agentPath, "AGENTS.md");
    const dest = join(targetDir, "AGENTS.md");
    await cp(src, dest, { force: true });
  }

  private async writeMcpConfig(targetDir: string, mcps: readonly ResolvedMcp[]): Promise<void> {
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

    const dest = join(targetDir, MCP_CONFIG_PATH);
    const json = `${JSON.stringify({ mcpServers }, null, 2)}\n`;
    await writeFile(dest, json, "utf8");
  }

  private async copySkills(targetDir: string, skills: readonly ResolvedSkill[]): Promise<void> {
    const skillsRoot = join(targetDir, DOT_DIR, "skills");
    for (const s of skills) {
      const dest = join(skillsRoot, flattenSkillName(s.skill.name));
      const hooksPath = join(s.path, "hooks");
      await mkdir(dest, { recursive: true });
      await cp(s.path, dest, {
        recursive: true,
        force: true,
        // Exclude only the top-level `hooks/` subdir of THIS skill.
        // Anything else (SKILL.md, nested assets, deep dirs called "hooks"
        // inside another subtree) is preserved.
        filter: (src) => src !== hooksPath && !src.startsWith(hooksPath + sep),
      });
    }
  }

  private async copyHooks(targetDir: string, skills: readonly ResolvedSkill[]): Promise<void> {
    const hooksDest = join(targetDir, DOT_DIR, "hooks");
    let destReady = false;

    for (const s of skills) {
      const src = join(s.path, "hooks", "copilot");
      try {
        const info = await stat(src);
        if (!info.isDirectory()) continue;
      } catch {
        // hooks/copilot/ missing for this skill — nothing to compose.
        continue;
      }

      if (!destReady) {
        await mkdir(hooksDest, { recursive: true });
        destReady = true;
      }
      await cp(src, hooksDest, { recursive: true, force: true });
    }
  }

  private async prepareWorkspace(targetDir: string): Promise<void> {
    try {
      // -q suppresses init banner; idempotent on re-run.
      await execFileAsync("git", ["init", "-q"], { cwd: targetDir });
    } catch (cause) {
      throw new WorkspacePrepFailed("git init", targetDir, cause as Error);
    }
  }
}
