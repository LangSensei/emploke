import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentResolveResult,
  applyFrontmatterPatch,
  type CatalogManager,
  stripMcpMeta,
} from "@emploke/catalog";
import { InvalidMcpJson } from "./errors.js";

const DOT_DIR = ".github";
const MCP_CONFIG_PATH = ".mcp.json";

/**
 * Separator used to flatten scoped names into single directory segments.
 *
 * Copilot CLI scans `.github/skills/` for one-level entries containing
 * `SKILL.md` and uses each skill's frontmatter `name` field as the
 * unique identifier in `<available_skills>`. A nested layout like
 * `.github/skills/langsensei/weather/` would be misread, so scoped skill
 * names must be flattened to a single segment.
 *
 * **Critical (#39)**: the CLI also silently de-duplicates skills with the
 * same `name` field — when two SKILL.md files share `name: tool-use`, only
 * the first one in readdir order survives, with no warning. This means the
 * frontmatter `name` field MUST also be rewritten to the flattened form,
 * not just the directory. Empirical testing confirmed that names
 * containing `__` / `.` / `-` are all accepted by the CLI; only `/`,
 * `:`, `@` are silently rejected.
 *
 * Double-underscore is unambiguous: catalog grammar is kebab-case
 * (`[a-z][a-z0-9]*(-[a-z0-9]+)*`), so `__` cannot appear in a valid name.
 *
 * Hook files in `.github/hooks/` get the same prefix for the same reason:
 * if two skills (different scopes, same short name) both contribute a
 * `setup.json` hook, the second would overwrite the first inside
 * `.github/hooks/`. Prefixing with `<scope>__<short>__` guarantees
 * disjoint filenames; per the official CLI hooks reference the runtime
 * loads every `*.json` under `.github/hooks/`, so the prefix is harmless.
 */
const SCOPE_FLATTEN_SEP = "__";

/**
 * Flatten `scope/name` into a single safe path segment.
 *
 * The implicit default scope `local/` (assigned to entries installed from
 * `file:` origins) is **stripped** rather than flattened — `.github/` paths
 * stay clean for the common single-machine case. Real third-party scopes
 * keep their `<scope>__<name>` form so cross-scope collisions still can't
 * happen. (Collision between `local/foo` → `foo` and a hypothetical
 * `<scope>/<name>` flattening to `foo` is impossible because `__` cannot
 * appear in a valid kebab-case `shortName`.)
 */
export function flattenSkillName(name: string): string {
  if (name.startsWith(LOCAL_SCOPE_PREFIX)) {
    return name.slice(LOCAL_SCOPE_PREFIX.length);
  }
  return name.replaceAll("/", SCOPE_FLATTEN_SEP);
}

const LOCAL_SCOPE_PREFIX = "local/";

/**
 * Bake `agent` into `workdir` so `copilot` can be launched there.
 *
 * Layout produced (relative to `workdir`):
 *
 *   AGENTS.md                       — copied verbatim from the resolved agent
 *   <agent siblings...>             — every other file the agent installed
 *   .mcp.json                       — `{ "mcpServers": { name: <parsed>, … } }`
 *   .github/skills/<flatname>/…     — each skill's content (excluding hooks/copilot/)
 *   .github/hooks/<flatname>__<file> — merged from each skill's hooks/copilot/
 *
 * Note: no `git init` is run. Copilot CLI loads hooks from
 * `<cwd>/.github/hooks/*.json` directly — it does not require a `.git/`
 * directory and does not walk up to find a git root (per the official
 * hooks reference at
 * docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference).
 * Skipping `git init` removes a hard dependency on the host's `git`
 * binary and avoids planting `.git/` directories that would otherwise
 * need cleanup on session/task purge.
 *
 * Source data is pulled from the catalog as `AsyncIterable<{relPath, content}>`
 * streams (see {@link CatalogManager.skillEntries} /
 * {@link CatalogManager.agentEntries}). The runtime never resolves on-disk
 * catalog paths; a future SQLite-backed catalog implementation works the same
 * way.
 *
 * **Trust handling moved out**: previous versions of this function also
 * appended `workdir` to `~/.copilot/config.json.trustedFolders`. That
 * concern is now `CopilotRuntime.buildLaunch`'s preflight, which writes
 * the workspace dir (idempotently, with ancestor coverage) into
 * `config.json` immediately before producing the launch spec. Per-session
 * provision no longer touches the user's Copilot config file.
 *
 * Idempotent in the trivial sense (re-running with the same inputs produces
 * the same files), but emploke's session manager always provisions into a
 * freshly-created empty workdir so we never rely on that.
 *
 * When two skills contribute non-hook files at the same relative path
 * under `.github/skills/<flatname>/`, the later one wins (impossible
 * across distinct skills since each gets its own directory; only matters
 * within a single skill's own tree). Hook files cannot collide across
 * skills because of the `<flatname>__` filename prefix.
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
}

/**
 * Copy every file the agent installed (AGENTS.md plus any sibling
 * templates / scripts) verbatim into `workdir`. The runtime treats agents
 * as multi-file entries — this is how operators bundle prompt fragments
 * or helper scripts alongside AGENTS.md.
 *
 * Hooks under the agent's own `hooks/copilot/` are merged into
 * `<workdir>/.github/hooks/` (same convention as skills) so an agent can
 * ship its own pretooluse / postresponse hooks. Filename prefix mirrors
 * the skill case to keep collision-resistance consistent.
 */
async function materializeAgent(
  workdir: string,
  agentName: string,
  catalog: CatalogManager,
): Promise<void> {
  const hooksDest = path.join(workdir, DOT_DIR, "hooks");
  let hooksDestReady = false;
  // Agents are singleton per workdir, so cross-agent hook-filename
  // collisions are impossible. Skip the `<flatname>__` prefix that
  // skills require for collision-resistance — the agent's hook files
  // land in `.github/hooks/` under their authored basenames.
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
 * keyed by MCP name. We strip the inline `_meta` block from each MCP body
 * before writing — Copilot CLI shouldn't see emploke's metadata.
 *
 * Keys in `.mcp.json` use the FULL MCP-spec name (e.g. `azure/mcp`, with
 * `/`). Copilot CLI accepts `/` in mcpServers keys (verified empirically),
 * so we don't need to flatten — keeping the spec name verbatim is the
 * cleaner contract for users who recognize MCPs by their spec FQN.
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
      const stripped = stripMcpMeta(raw, `mcps:${mcp.name}`);
      mcpServers[mcp.name] = stripped;
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
 * (Copilot's hook discovery only looks there) with a per-skill filename
 * prefix to prevent cross-skill collisions.
 *
 * The COPY of `SKILL.md` written to `.github/` has its frontmatter `name`
 * field rewritten to the flattened form (`<scope>__<short>`). The catalog
 * source SKILL.md is never modified — frontmatter rewriting happens only
 * on the projection that lands inside the workdir, so the catalog stays
 * portable. See {@link SCOPE_FLATTEN_SEP} for why this is required.
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
    const flatName = flattenSkillName(s.skill.name);
    const skillDest = path.join(skillsRoot, flatName);
    const hookPrefix = `${flatName}${SCOPE_FLATTEN_SEP}`;
    await mkdir(skillDest, { recursive: true });
    for await (const { relPath, content } of catalog.skillEntries(s.skill.name)) {
      const hookRel = stripHooksPrefix(relPath);
      if (hookRel !== null) {
        if (!hooksDestReady) {
          await mkdir(hooksDest, { recursive: true });
          hooksDestReady = true;
        }
        await writeFileAt(hooksDest, prefixHookPath(hookRel, hookPrefix), content);
      } else if (relPath === "SKILL.md") {
        // Rewrite the frontmatter `name` field on the COPY only. Required to
        // dodge the Copilot CLI's silent same-name dedup. Catalog source is
        // untouched.
        const rewritten = applyFrontmatterPatch(content.toString("utf8"), { name: flatName });
        await writeFileAt(skillDest, relPath, Buffer.from(rewritten, "utf8"));
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
 * Prefix the *filename* (not the path) of `hookRel` with `prefix`. Hooks
 * may be nested (`subdir/setup.json`) — only the leaf gets the prefix to
 * keep the directory shape intact in case Copilot ever cares.
 */
function prefixHookPath(hookRel: string, prefix: string): string {
  const idx = hookRel.lastIndexOf("/");
  if (idx === -1) return `${prefix}${hookRel}`;
  return `${hookRel.slice(0, idx + 1)}${prefix}${hookRel.slice(idx + 1)}`;
}

/**
 * Write `content` to `<destRoot>/<relPath>`, creating intermediate
 * directories. `relPath` is POSIX-style (the catalog contract); we split
 * on `/` and re-join via `path.join` so it materializes correctly on
 * Windows too.
 *
 * **Defense-in-depth**: validate the resolved final path stays inside
 * `destRoot`. The catalog walker already rejects symlinks and the names
 * it yields are individual `readdir` segments (no `..` possible), so this
 * check is belt-and-braces — but a corrupted SQLite-backed catalog row
 * that returned `relPath: "../foo"`, or an entry filename containing a
 * literal Windows-style backslash that survived `toPosix`, would
 * otherwise let writes escape the destination. Refusing is cheap.
 */
async function writeFileAt(destRoot: string, relPath: string, content: Buffer): Promise<void> {
  const segments = relPath.split("/");
  const fileName = segments.pop();
  if (!fileName) return;
  const dir = segments.length > 0 ? path.join(destRoot, ...segments) : destRoot;
  const target = path.join(dir, fileName);
  // Resolve both sides so symlink-free comparisons work consistently
  // across Windows / POSIX.
  const resolvedDest = path.resolve(target);
  const resolvedRoot = path.resolve(destRoot);
  if (resolvedDest !== resolvedRoot && !resolvedDest.startsWith(resolvedRoot + path.sep)) {
    throw new Error(
      `refusing to write catalog entry outside workdir: relPath ${JSON.stringify(relPath)} resolves to ${resolvedDest}`,
    );
  }
  if (segments.length > 0) await mkdir(dir, { recursive: true });
  await writeFile(target, content);
}
