/**
 * ScopeResolver — three-layer scope resolution for catalog entries.
 *
 *   L1 inline:     `scope` field in entry frontmatter (handled by callers
 *                  before invoking the resolver — this layer never sees L1)
 *   L2 catalog.json: `scopeMappings: { <publisher-pattern>: <scope> }`,
 *                  longest-match wins
 *   L3 default:    {@link defaultMapping(origin)} from `@emploke/catalog-fetcher`
 *
 * On a fresh catalog (no L2 mapping for a publisher), {@link resolve}
 * falls through to L3 and AUTO-WRITES the L3 mapping into L2 so future
 * installs from the same publisher get a stable, explicit scope. The
 * resolver caches the loaded `catalog.json` snapshot in memory; writes
 * go through the {@link CatalogRepository} (atomic) and refresh the
 * snapshot synchronously.
 *
 * **Concurrency**: callers serialize installs via the catalog write
 * lock, so the read-modify-write pattern in {@link resolve} is safe
 * within a single process. Multi-process scenarios would need
 * filesystem locking; not in scope for Phase 2.
 *
 * **No dynamic reload**: the in-memory snapshot is taken at boot
 * (and after each write). External edits to `catalog.json` while the
 * server is running take effect on next restart. Acceptable for a
 * single-server developer-tool deployment; would need a file-watch
 * + debounce for multi-process scenarios.
 */
import { defaultMapping, type ParsedOrigin, parseOrigin } from "@emploke/catalog-fetcher";
import {
  CATALOG_CONFIG_VERSION,
  type CatalogConfig,
  type CatalogRepository,
} from "./repositories/catalog-repository.js";

/** The layer that produced the scope. Surfaced in `ResolveManifest` for UI hints. */
export type ScopeSource = "L2" | "L3";

/** Result of {@link ScopeResolver.resolve} — what the caller binds the entry to. */
export interface ResolvedScope {
  readonly scope: string;
  readonly source: ScopeSource;
  /** The L2 pattern that matched, or the L3 pattern that was synthesised. */
  readonly matchedPattern: string;
}

export class ScopeResolver {
  private snapshot: CatalogConfig;
  private compiled: Compiled[];

  /**
   * Build a resolver around an existing snapshot. Callers normally
   * construct via {@link load}, which reads from the repository and
   * synthesises a v1 stub when `catalog.json` is absent.
   */
  constructor(
    private readonly repo: CatalogRepository,
    snapshot: CatalogConfig,
  ) {
    this.snapshot = snapshot;
    this.compiled = compileMappings(snapshot.scopeMappings);
  }

  static async load(repo: CatalogRepository): Promise<ScopeResolver> {
    const stored = await repo.read();
    const snapshot: CatalogConfig = stored ?? {
      version: CATALOG_CONFIG_VERSION,
      scopeMappings: {},
    };
    return new ScopeResolver(repo, snapshot);
  }

  /**
   * Resolve the scope for an origin via L2 longest-match → L3 default.
   *
   * If L3 is used and the L3 pattern is not yet in `catalog.json`, the
   * mapping is auto-written to L2 (atomic via the repository) and the
   * in-memory snapshot is refreshed in the same call. The auto-write
   * is `await`ed so callers proceeding to install the entry are
   * guaranteed the mapping is durable before they store the entry.
   */
  async resolve(origin: string): Promise<ResolvedScope> {
    const parsed = parseOrigin(origin);
    return this.resolveParsed(parsed);
  }

  /** Pre-parsed-origin variant. Saves a re-parse for callers that already have one. */
  async resolveParsed(parsed: ParsedOrigin): Promise<ResolvedScope> {
    const candidate = originCandidate(parsed);
    const l2 = this.matchL2(candidate);
    if (l2 !== null) return { scope: l2.scope, source: "L2", matchedPattern: l2.pattern };

    const l3 = defaultMapping(parsed);
    if (this.snapshot.scopeMappings[l3.pattern] === undefined) {
      await this.upsertMapping(l3.pattern, l3.scope);
    }
    return { scope: l3.scope, source: "L3", matchedPattern: l3.pattern };
  }

  /**
   * Read-only variant: never writes back to L2. Used by `resolveInstall`
   * when previewing scope assignment without committing to anything.
   */
  preview(origin: string): ResolvedScope {
    const parsed = parseOrigin(origin);
    const candidate = originCandidate(parsed);
    const l2 = this.matchL2(candidate);
    if (l2 !== null) return { scope: l2.scope, source: "L2", matchedPattern: l2.pattern };
    const l3 = defaultMapping(parsed);
    return { scope: l3.scope, source: "L3", matchedPattern: l3.pattern };
  }

  /**
   * Replace (or insert) a mapping. Writes through to the repository
   * atomically and refreshes the in-memory snapshot. Exposed for
   * future "edit scope mapping" UI flows; current install paths use
   * the auto-write inside {@link resolve}.
   */
  async upsertMapping(pattern: string, scope: string): Promise<void> {
    const next: CatalogConfig = {
      version: CATALOG_CONFIG_VERSION,
      scopeMappings: { ...this.snapshot.scopeMappings, [pattern]: scope },
    };
    await this.repo.write(next);
    this.snapshot = next;
    this.compiled = compileMappings(next.scopeMappings);
  }

  /** Return a snapshot of all current scopeMappings. Read-only view. */
  mappings(): Readonly<Record<string, string>> {
    return this.snapshot.scopeMappings;
  }

  private matchL2(candidate: string): { scope: string; pattern: string } | null {
    let bestLen = -1;
    let best: { scope: string; pattern: string } | null = null;
    for (const c of this.compiled) {
      if (!candidate.startsWith(c.prefix)) continue;
      if (c.prefix.length > bestLen) {
        bestLen = c.prefix.length;
        best = { scope: c.scope, pattern: c.original };
      }
    }
    return best;
  }
}

interface Compiled {
  /** The string up to (and excluding) the trailing `*`. Used for prefix-match. */
  readonly prefix: string;
  readonly scope: string;
  readonly original: string;
}

function compileMappings(mappings: Readonly<Record<string, string>>): Compiled[] {
  const out: Compiled[] = [];
  for (const [pattern, scope] of Object.entries(mappings)) {
    out.push({ prefix: stripWildcardSuffix(pattern), scope, original: pattern });
  }
  // Stable order isn't required for matching (longest-match wins), but
  // sort by descending prefix-length so the matcher returns first.
  out.sort((a, b) => b.prefix.length - a.prefix.length);
  return out;
}

function stripWildcardSuffix(pattern: string): string {
  return pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
}

/**
 * Convert a {@link ParsedOrigin} into the candidate string that L2
 * patterns are matched against. The shape mirrors the patterns we
 * write in {@link defaultMapping}: `<scheme-key>/<distinguishing-path>`
 * so longest-match works naturally.
 *
 *  - github → `github.com/<owner>/<repo>[/<path>]`
 *  - file   → `file://<path>`
 */
function originCandidate(parsed: ParsedOrigin): string {
  switch (parsed.scheme) {
    case "github": {
      const path = parsed.path !== null && parsed.path.length > 0 ? `/${parsed.path}` : "";
      return `github.com/${parsed.owner}/${parsed.repo}${path}`;
    }
    case "file":
      return `file://${parsed.path}`;
  }
}
