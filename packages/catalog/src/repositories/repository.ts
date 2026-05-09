/**
 * Catalog Repository contracts.
 *
 * The Repository layer is the seam between the on-disk catalog (or any future
 * backend like SQLite) and the Store layer that parses frontmatter / enforces
 * dependency rules / maintains the in-memory cache.
 *
 * Repositories deal in raw bytes addressed by entry name. They must NOT parse
 * frontmatter, build dependency graphs, or maintain caches — those are Store
 * responsibilities. Repositories MAY validate names defensively before
 * composing paths.
 *
 * `scan()` returns raw entries; the Store decides which are valid.
 */

/** A document-style (dir-backed) catalog entry as returned by `scan()`. */
export interface DocumentRepoEntry {
  /** Raw file content (e.g. AGENTS.md / SKILL.md). */
  readonly content: string;
  /**
   * Identifier suitable for diagnostic messages — typically the on-disk path
   * for `Fs*Repository` impls, or a synthetic label for in-memory impls.
   * The Store passes this through to {@link parseFrontmatter} for nice errors.
   */
  readonly sourcePath: string;
}

/** Repository of agent documents (`AGENTS.md` per entry directory). */
export interface AgentRepository {
  /** Read the AGENTS.md content for `name`, or `null` if absent. */
  read(name: string): Promise<string | null>;
  /** Replace the AGENTS.md content for `name`. Creates parent dirs as needed. */
  write(name: string, content: string): Promise<void>;
  /**
   * Atomically install a directory tree under `name`, replacing any existing
   * entry. The source directory must contain an AGENTS.md; arbitrary sibling
   * files are preserved verbatim in the installed copy.
   */
  installFromDir(name: string, sourceDir: string): Promise<void>;
  /** Remove the entry for `name`. No-op if absent. */
  delete(name: string): Promise<void>;
  /** Enumerate every candidate AGENTS.md the repository knows about. */
  scan(): Promise<DocumentRepoEntry[]>;
}

/** Repository of skill documents (`SKILL.md` per entry directory). */
export interface SkillRepository {
  read(name: string): Promise<string | null>;
  write(name: string, content: string): Promise<void>;
  installFromDir(name: string, sourceDir: string): Promise<void>;
  delete(name: string): Promise<void>;
  scan(): Promise<DocumentRepoEntry[]>;
}

/** A file-style catalog entry whose name derives from its filename. */
export interface McpRepoEntry {
  /** Resolved name (`scope/base` or `base`), derived from path. */
  readonly name: string;
  /** Raw file content (JSON string, written verbatim — never re-serialized). */
  readonly content: string;
  /** Diagnostic identifier (path or synthetic label). */
  readonly sourcePath: string;
}

/** Repository of MCP definitions (`<name>.json` per entry). */
export interface McpRepository {
  read(name: string): Promise<string | null>;
  /** Write JSON content for `name`. Creates parent dirs (for scoped names) as needed. */
  write(name: string, content: string): Promise<void>;
  delete(name: string): Promise<void>;
  scan(): Promise<McpRepoEntry[]>;
  /**
   * Optional capability: return an on-disk path for `name`, used by callers
   * that need to spawn an external process pointed at the JSON file (e.g.
   * `--config <path>`). Returns `null` for non-file-backed repositories
   * (callers must materialize the JSON themselves in that case).
   *
   * The repository does NOT verify the file exists — callers should check
   * via `read(name)` first if presence matters.
   */
  pathFor?(name: string): string;
}
