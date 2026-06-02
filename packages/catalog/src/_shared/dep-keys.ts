/**
 * Parametric dep keys. Each anchored kind (agent, skill, future kinds)
 * declares its own dep-spec set as a const array (e.g. agents:
 * `["skills", "mcps"]`). Helpers in this file operate generically over
 * `<K extends string>` and never name a specific dep-kind, so adding a
 * new kind never requires changes here — only a new spec declaration
 * in the per-kind frontmatter module.
 */

/** A resolved fqn-form dep reference. */
export interface DependencyRef {
  readonly fqn: string;
}

/** fqn-form dep view, keyed by a per-kind dep-name union (e.g. `"skills" | "mcps"`). */
export type FqnDeps<K extends string> = Readonly<Record<K, readonly DependencyRef[]>>;

/** Origin-URI dep view as declared in the frontmatter (pre-resolution). */
export type OriginDeps<K extends string> = Readonly<Record<K, readonly string[]>>;

/**
 * A single dep-kind declaration. `skipSelf` mirrors the skill-side
 * behaviour: a skill that lists itself as a skill-dep silently drops
 * the self-edge at write time (agent does not — agents are top-of-
 * graph and can't self-cycle in practice).
 */
export interface DepSpec<K extends string> {
  readonly kind: K;
  readonly skipSelf?: boolean;
}

/**
 * Declare a per-kind dep-spec set. The `const` type parameter narrows
 * `K` to the union of the literal kind strings passed in (so callers
 * get a precisely-typed `FqnDeps<"skills" | "mcps">` instead of
 * `FqnDeps<string>`).
 */
export function defineDepSpecs<const K extends string>(
  ...specs: readonly DepSpec<K>[]
): readonly DepSpec<K>[] {
  return specs;
}

function emptyEntries<K extends string, V>(
  specs: readonly DepSpec<K>[],
  empty: () => readonly V[],
): Readonly<Record<K, readonly V[]>> {
  const out = {} as Record<K, readonly V[]>;
  for (const s of specs) out[s.kind] = empty();
  return out;
}

export function emptyDeps<K extends string>(specs: readonly DepSpec<K>[]): FqnDeps<K> {
  return emptyEntries<K, DependencyRef>(specs, () => []);
}

export function emptyOriginDeps<K extends string>(specs: readonly DepSpec<K>[]): OriginDeps<K> {
  return emptyEntries<K, string>(specs, () => []);
}

/** Fill in any missing dep-kind buckets with empty arrays. */
export function normaliseFqnDeps<K extends string>(
  specs: readonly DepSpec<K>[],
  deps: Partial<FqnDeps<K>> | undefined,
): FqnDeps<K> {
  const out = {} as Record<K, readonly DependencyRef[]>;
  for (const s of specs) {
    out[s.kind] = deps?.[s.kind] ?? [];
  }
  return out;
}

/** Fill in any missing dep-kind buckets with empty arrays. */
export function normaliseOriginDeps<K extends string>(
  specs: readonly DepSpec<K>[],
  deps: Partial<OriginDeps<K>> | undefined,
): OriginDeps<K> {
  const out = {} as Record<K, readonly string[]>;
  for (const s of specs) {
    out[s.kind] = deps?.[s.kind] ?? [];
  }
  return out;
}

/**
 * Project an `FqnDeps<K>` into the wire-shape used by `toJSON`: only
 * populated dep-kinds are emitted, and the whole `dependencies` block
 * is omitted if every dep-kind is empty (returns `undefined`).
 */
export function depsToJSON<K extends string>(
  specs: readonly DepSpec<K>[],
  deps: FqnDeps<K>,
): Partial<FqnDeps<K>> | undefined {
  const out: Partial<Record<K, readonly DependencyRef[]>> = {};
  let any = false;
  for (const s of specs) {
    const list = deps[s.kind];
    if (list.length > 0) {
      out[s.kind] = list;
      any = true;
    }
  }
  return any ? out : undefined;
}
