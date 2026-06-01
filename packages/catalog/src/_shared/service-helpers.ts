import matter from "gray-matter";
import type { EntryFile } from "../fetcher/index.js";
import { normalizeOrigin, parseOrigin } from "../fetcher/index.js";
import { ImmutableOriginError, isOriginMutable } from "../origin-mutability.js";
import type { DepSpec, OriginDeps } from "./dep-keys.js";
import { normaliseOriginDeps } from "./dep-keys.js";

/**
 * Service-layer helpers shared by `agent/agent-service.ts` and
 * `skill/skill-service.ts`. Each helper is a stateless function over
 * an explicit dependency record so the per-kind service class can
 * compose them without inheritance.
 *
 * No abstract classes, no `extends`, no shared mutable state.
 */

/** One file pulled from the fetcher tree. */
export interface AnchoredFile {
  readonly relPath: string;
  readonly content: Buffer;
}

export interface AnchoredFetcher {
  fetchAnchor(origin: string): Promise<string>;
  fetchTree(origin: string): AsyncIterable<EntryFile>;
}

export interface AnchoredResolveOptions {
  signal?: AbortSignal;
  onProgress?: (event: AnchoredResolveEvent) => void;
}

export type AnchoredResolveEvent =
  | { type: "fetching"; origin: string }
  | { type: "fetched"; origin: string; fqn: string }
  | { type: "alreadyInstalled"; fqn: string }
  | { type: "failed"; origin: string; error: unknown };

export interface AnchoredResolvedNode<K extends string> {
  readonly fqn: string;
  readonly origin: string;
  readonly anchorContent: string;
  readonly version: string;
  readonly depsRefs: OriginDeps<K>;
}

export type AnchoredResolveConflict = {
  readonly origin: string;
  readonly fqn: string | null;
  readonly reason:
    | { kind: "fetch-failed"; cause: unknown }
    | { kind: "parse-failed"; cause: unknown }
    | { kind: "origin-conflict"; existingOrigin: string };
};

export interface AnchoredResolvePlan<K extends string> {
  readonly node: AnchoredResolvedNode<K> | null;
  readonly conflict: AnchoredResolveConflict | null;
}

/**
 * Minimal entity shape the service helpers need from the per-kind
 * entity. Each per-kind entity already exposes these — this just
 * names the contract.
 */
export interface AnchoredEntityLike<K extends string> {
  readonly fqn: string;
  readonly origin: string;
  readonly version: string;
  readonly depsRefs: OriginDeps<K>;
  readonly prereqs: string | undefined;
  readonly prereqsAck: boolean;
}

/**
 * Minimal repo surface the service helpers need. Per-kind repos
 * implement (and exceed) this; the helpers only use what's listed.
 */
export interface AnchoredRepoLookup<E> {
  findByFqn(fqn: string): Promise<E | null>;
}

/** Returns true iff `a` and `b` are equivalent after origin normalisation. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return normalizeOrigin(parseOrigin(a)) === normalizeOrigin(parseOrigin(b));
  } catch {
    return a === b;
  }
}

/** FQN-immutable patch keys — never accepted by `updateMetadata`. */
export const FORBIDDEN_METADATA_PATCH_KEYS: ReadonlySet<string> = new Set(["name", "scope", "fqn"]);

/**
 * Apply a partial patch to the YAML frontmatter of a markdown
 * document. `null` / `undefined` patch values DELETE the key. Body
 * bytes preserved verbatim. Output: `---\n<yaml>\n---\n<body>`. YAML
 * comments and original key order are NOT preserved (gray-matter /
 * js-yaml limitation).
 */
export function applyFrontmatterPatch(raw: string, patch: Record<string, unknown>): string {
  const file = matter(raw);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) delete file.data[k];
    else file.data[k] = v;
  }
  return matter.stringify(file.content, file.data);
}

export interface ResolveAnchoredOriginArgs<E, K extends string> {
  readonly origin: string;
  readonly fetcher: AnchoredFetcher;
  readonly repo: AnchoredRepoLookup<E>;
  readonly createEntity: (raw: string, origin: string, sourceLabel: string) => E;
  readonly options?: AnchoredResolveOptions;
  /** Pull the depsRefs out of a freshly-created entity in the per-kind dep-key shape. */
  readonly depsOf: (entity: E) => OriginDeps<K>;
  /** Project an entity into its identity + version (used to build the resolved node). */
  readonly identityOf: (entity: E) => { fqn: string; origin: string; version: string };
  /** Pull the persisted origin off a previously-installed entity (for the origin-conflict check). */
  readonly originOf: (entity: E) => string;
  /** Spec set used to normalise the resolved depsRefs into a dense OriginDeps. */
  readonly depSpecs: readonly DepSpec<K>[];
}

/**
 * Pure resolve workflow: fetch the anchor bytes, parse them into an
 * entity, check for origin conflicts against the local repo, build the
 * resolved-node payload. Returns `{node, conflict}` — the caller maps
 * the conflict to the per-kind error class.
 */
export async function resolveAnchoredOrigin<E, K extends string>(
  args: ResolveAnchoredOriginArgs<E, K>,
): Promise<AnchoredResolvePlan<K>> {
  const { origin, fetcher, repo, createEntity, depsOf, identityOf, originOf, depSpecs } = args;
  const onProgress = args.options?.onProgress ?? (() => {});

  onProgress({ type: "fetching", origin });
  let anchorBytes: string;
  try {
    anchorBytes = await fetcher.fetchAnchor(origin);
  } catch (cause) {
    onProgress({ type: "failed", origin, error: cause });
    return {
      node: null,
      conflict: { origin, fqn: null, reason: { kind: "fetch-failed", cause } },
    };
  }

  let entity: E;
  try {
    entity = createEntity(anchorBytes, origin, `resolve:${origin}`);
  } catch (cause) {
    onProgress({ type: "failed", origin, error: cause });
    return {
      node: null,
      conflict: { origin, fqn: null, reason: { kind: "parse-failed", cause } },
    };
  }

  const id = identityOf(entity);
  const existing = await repo.findByFqn(id.fqn);
  if (existing !== null && !sameOrigin(originOf(existing), id.origin)) {
    return {
      node: null,
      conflict: {
        origin,
        fqn: id.fqn,
        reason: { kind: "origin-conflict", existingOrigin: originOf(existing) },
      },
    };
  }

  const depsRefs = normaliseOriginDeps(depSpecs, depsOf(entity));
  const node: AnchoredResolvedNode<K> = {
    fqn: id.fqn,
    origin: id.origin,
    anchorContent: anchorBytes,
    version: id.version,
    depsRefs,
  };
  onProgress({ type: "fetched", origin, fqn: node.fqn });
  return { node, conflict: null };
}

/**
 * Pull every file from the fetcher tree into a `Map<relPath, Buffer>`,
 * surfacing the anchor's bytes separately so the caller can re-validate
 * the version field before persisting.
 */
export async function readFetcherTree(
  fetcher: AnchoredFetcher,
  origin: string,
  anchorFilename: string,
): Promise<{ files: Map<string, Buffer>; anchorContent: string | null }> {
  const files = new Map<string, Buffer>();
  let anchorContent: string | null = null;
  for await (const file of fetcher.fetchTree(origin)) {
    files.set(file.relPath, file.content);
    if (file.relPath === anchorFilename) {
      anchorContent = file.content.toString("utf8");
    }
  }
  return { files, anchorContent };
}

/** Throws `ImmutableOriginError` iff `origin` is not file:-mutable. */
export function assertOriginMutable(fqn: string, origin: string): void {
  if (!isOriginMutable(origin)) throw new ImmutableOriginError(fqn, origin);
}

/**
 * Helper for the `siblings.skills + siblings.mcps` resolution pattern
 * used by `agent-service`. The skill-service variant resolves the
 * skills bucket against its OWN repo, so it doesn't compose this
 * helper — it inlines the lookup loop instead (one method, three
 * lines, not worth a second helper signature).
 */
export async function resolveSiblingOrigins<K extends string>(
  refs: OriginDeps<K>,
  lookups: Partial<Record<K, (origin: string) => Promise<{ fqn: string } | null>>>,
): Promise<Record<K, string[]>> {
  const out = {} as Record<K, string[]>;
  for (const k of Object.keys(refs) as K[]) {
    const lookup = lookups[k];
    const acc: string[] = [];
    if (lookup !== undefined) {
      for (const origin of refs[k]) {
        const sib = await lookup(origin);
        if (sib !== null) acc.push(sib.fqn);
      }
    }
    out[k] = acc;
  }
  return out;
}
