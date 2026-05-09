/**
 * Catalog Repository contracts.
 *
 * The Repository layer is the seam between the on-disk catalog (or any future
 * backend like SQLite) and the Catalog layer that parses frontmatter / enforces
 * dependency rules / maintains the in-memory cache.
 *
 * Repositories deal in raw bytes addressed by entry name. They must NOT parse
 * frontmatter, build dependency graphs, or maintain caches — those are
 * Catalog-layer responsibilities. Repositories MAY validate names defensively
 * before composing paths.
 *
 * `scan()` returns raw entries; the Catalog layer decides which are valid.
 */

/** A document-style (dir-backed) catalog entry as returned by `scan()`. */
export interface DocumentRepoEntry {
  /** Raw file content (e.g. AGENTS.md / SKILL.md). */
  readonly content: string;
  /**
   * Identifier suitable for diagnostic messages — typically the on-disk path
   * for `Fs*Repository` impls, or a synthetic label for in-memory impls.
   * The Catalog layer passes this through to {@link parseFrontmatter} for
   * nice errors.
   */
  readonly sourcePath: string;
}

/**
 * One file inside a multi-file catalog entry (skill or agent), as yielded
 * by {@link SkillRepository.entries} / {@link AgentRepository.entries}.
 *
 * The path/content separation is the universal multi-backend shape — fs
 * yields `{ relPath, await readFile(absPath) }` per walked file; SQLite
 * would yield `{ rel_path, content_blob }` rows; an object store would
 * yield `{ key.slice(prefix.length), GET(key) }`. None of those need
 * to materialize anything to a temp dir before serving the consumer.
 */
export interface CatalogEntryFile {
  /**
   * Path relative to the entry root. ALWAYS POSIX-style (`/` separators)
   * regardless of the host OS, so consumers can safely concatenate without
   * re-normalising. The entry's anchor file (SKILL.md / AGENTS.md) is
   * yielded under that name; sibling files keep their tree shape.
   */
  readonly relPath: string;
  /** Raw bytes of the file. Buffer (not string) so binary assets survive. */
  readonly content: Buffer;
}

/** Repository of agent documents (`AGENTS.md` per entry directory + siblings). */
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
  /**
   * Stream every file that belongs to the named agent, including AGENTS.md
   * itself. Order is unspecified; consumers must not depend on it. Throws
   * if the entry doesn't exist.
   */
  entries(name: string): AsyncIterable<CatalogEntryFile>;
}

/** Repository of skill documents (`SKILL.md` per entry directory + siblings). */
export interface SkillRepository {
  read(name: string): Promise<string | null>;
  write(name: string, content: string): Promise<void>;
  installFromDir(name: string, sourceDir: string): Promise<void>;
  delete(name: string): Promise<void>;
  scan(): Promise<DocumentRepoEntry[]>;
  /**
   * Stream every file that belongs to the named skill, including SKILL.md.
   * The runtime uses this to bake skills into a session workdir without
   * needing an on-disk source path. Order is unspecified.
   */
  entries(name: string): AsyncIterable<CatalogEntryFile>;
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

/**
 * Repository of MCP definitions (`<name>.json` per entry).
 *
 * MCPs are single-file, so the read/write byte API is sufficient — no
 * `entries()` stream needed; consumers call `read(name)` to get the JSON
 * content directly.
 */
export interface McpRepository {
  read(name: string): Promise<string | null>;
  /** Write JSON content for `name`. Creates parent dirs (for scoped names) as needed. */
  write(name: string, content: string): Promise<void>;
  delete(name: string): Promise<void>;
  scan(): Promise<McpRepoEntry[]>;
}
