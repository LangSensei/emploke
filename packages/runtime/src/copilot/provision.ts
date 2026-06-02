import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import {
  type PlaceholderContext,
  substitutePlaceholdersDeep,
  UnknownPlaceholderError,
} from "../placeholders.js";
import type { AgentContentSource, ResolvedAgent } from "../types.js";
import { InvalidMcpJson } from "./errors.js";

/**
 * Apply a partial patch to the YAML frontmatter of a markdown document.
 * `null` / `undefined` patch values DELETE the key. Body bytes preserved
 * verbatim. Output: `---\n<yaml>\n---\n<body>`. YAML comments and
 * original key order are NOT preserved (gray-matter / js-yaml limitation).
 */
function applyFrontmatterPatch(raw: string, patch: Record<string, unknown>): string {
  const file = matter(raw);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) delete file.data[k];
    else file.data[k] = v;
  }
  return matter.stringify(file.content, file.data);
}

const DOT_DIR = ".github";
/**
 * Filename of the workspace-level MCP config that this module writes
 * inside the spawn cwd (i.e. `taskDir`) when the resolved agent declares
 * any MCP servers. Single source of truth for the `.mcp.json` literal —
 * `launch-headless.ts` re-exports this so its existence probe and the
 * `--additional-mcp-config` argv stay in lockstep with the writer here.
 */
export const COPILOT_MCP_CONFIG = ".mcp.json";

/**
 * Separator used to flatten scoped names into single directory segments.
 *
 * Copilot CLI scans `.github/skills/` for one-level entries containing
 * `SKILL.md` and uses each skill's frontmatter `name` field as the
 * unique identifier in `<available_skills>`. A nested layout like
 * `.github/skills/langsensei/weather/` would be misread, so scoped skill
 * names must be flattened to a single segment.
 *
 * **Critical**: the CLI also silently de-duplicates skills with the
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
 * The default scope `public/` (assigned to entries whose frontmatter
 * omits `scope:`) is **stripped** rather than flattened — `.github/`
 * paths stay clean for the common case. Real third-party scopes keep
 * their `<scope>__<name>` form so cross-scope collisions still can't
 * happen. (Collision between `public/foo` → `foo` and a hypothetical
 * `<scope>/<name>` flattening to `foo` is impossible because `__`
 * cannot appear in a valid kebab-case `shortName`.)
 */
export function flattenSkillName(name: string): string {
  if (name.startsWith(DEFAULT_SCOPE_PREFIX)) {
    return name.slice(DEFAULT_SCOPE_PREFIX.length);
  }
  return name.replaceAll("/", SCOPE_FLATTEN_SEP);
}

const DEFAULT_SCOPE_PREFIX = "public/";

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
 * `placeholders.workspaceDir` and `placeholders.sharedDir` are required;
 * they're substituted into MCP `args` / `env` / nested string fields so
 * marketplace-shareable specs can refer to per-workspace and per-machine
 * state without baking absolute host paths into JSON.
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
 * streams (see {@link AgentContentSource.skillEntries} /
 * {@link AgentContentSource.agentEntries}). The runtime never resolves on-disk
 * catalog paths; a future SQLite-backed catalog implementation works the same
 * way.
 *
 * Does NOT touch the Copilot CLI's `config.json` `trustedFolders`.
 * Folder-trust is `CopilotRuntime.buildInteractiveLaunch`'s preflight
 * (it writes the workspace dir into `config.json` immediately before
 * producing the launch spec, idempotently and with ancestor
 * coverage). Keeping the two concerns separate lets workspaces that
 * are only used for SDK-headless tasks skip the trust write entirely.
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
  agent: ResolvedAgent,
  catalog: AgentContentSource,
  placeholders: PlaceholderContext,
): Promise<void> {
  await mkdir(workdir, { recursive: true });
  // Each branch writes under a disjoint output prefix
  // (`<workdir>/`, `<workdir>/.mcp.json`, `<workdir>/.github/skills/`)
  // and creates its own intermediate dirs idempotently with
  // `mkdir(..., recursive: true)`. The only overlap is
  // `<workdir>/.github/hooks/`, which both `materializeAgent` and
  // `materializeSkills` may create — `mkdir(recursive: true)` is
  // concurrency-safe on that race.
  await Promise.all([
    materializeAgent(workdir, agent.agent.fqn, catalog),
    writeMcpConfig(workdir, agent.mcps, catalog, placeholders),
    materializeSkills(workdir, agent.skills, catalog),
  ]);
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
  catalog: AgentContentSource,
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
 * String fields inside each MCP server config (anywhere in `args`,
 * `env`, or nested objects) get emploke's placeholder grammar resolved
 * via {@link substitutePlaceholdersDeep}. This is what lets a marketplace
 * MCP spec say `"--storage-state ${workspaceDir}/playwright/state.json"`
 * and end up with a real per-workspace path on disk — no `bash -c` shell
 * trickery, no `$HOME` env-var reliance, works on Windows.
 *
 * A typo in a placeholder (`${workspceDir}`) surfaces as
 * {@link UnknownPlaceholderError} → wrapped as {@link InvalidMcpJson}
 * here so the caller treats it the same as any other malformed-spec
 * failure. The error's `.message` carries the offending MCP name +
 * placeholder so the dashboard can show the user where to fix.
 *
 * Keys in `.mcp.json` use the FULL MCP-spec name (e.g. `azure/mcp`, with
 * `/`). Copilot CLI accepts `/` in mcpServers keys (verified empirically),
 * so we don't need to flatten — keeping the spec name verbatim is the
 * cleaner contract for users who recognize MCPs by their spec FQN.
 */
async function writeMcpConfig(
  workdir: string,
  mcps: readonly { readonly fqn: string }[],
  catalog: AgentContentSource,
  placeholders: PlaceholderContext,
): Promise<void> {
  if (mcps.length === 0) return;

  const mcpServers: Record<string, unknown> = {};
  for (const mcp of mcps) {
    let stripped: Record<string, unknown>;
    try {
      stripped = await catalog.getMcpRuntimeConfig(mcp.fqn);
    } catch (cause) {
      throw new InvalidMcpJson(mcp.fqn, cause as Error);
    }
    try {
      mcpServers[mcp.fqn] = substitutePlaceholdersDeep(stripped, placeholders, `mcps:${mcp.fqn}`);
    } catch (cause) {
      if (cause instanceof UnknownPlaceholderError) {
        throw new InvalidMcpJson(mcp.fqn, cause);
      }
      throw cause;
    }
  }

  const dest = path.join(workdir, COPILOT_MCP_CONFIG);
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
  skills: readonly { readonly skill: { readonly fqn: string } }[],
  catalog: AgentContentSource,
): Promise<void> {
  const skillsRoot = path.join(workdir, DOT_DIR, "skills");
  const hooksDest = path.join(workdir, DOT_DIR, "hooks");
  let hooksDestReady = false;

  for (const s of skills) {
    const flatName = flattenSkillName(s.skill.fqn);
    const skillDest = path.join(skillsRoot, flatName);
    const hookPrefix = `${flatName}${SCOPE_FLATTEN_SEP}`;
    await mkdir(skillDest, { recursive: true });
    for await (const { relPath, content } of catalog.skillEntries(s.skill.fqn)) {
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
