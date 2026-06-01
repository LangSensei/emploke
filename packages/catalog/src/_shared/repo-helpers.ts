import { type DepSpec, emptyDeps, type FqnDeps } from "./dep-keys.js";

/**
 * Drizzle-CRUD helpers shared between `agent/agent-repository.ts` and
 * `skill/skill-repository.ts`. Every helper is stateless and operates
 * on plain data — the actual drizzle `tx.insert(...).values(...)` /
 * `tx.delete(...).where(...)` calls stay INSIDE the per-kind repo
 * methods where the caller's table types are concrete. The helpers
 * here only handle the cross-kind LOGIC that has no per-kind type:
 *
 *  - dedup + skipSelf application for dep refs
 *  - per-source aggregation of flat dep rows into `FqnDeps<K>`
 *  - blob-content normalisation
 *
 * This is the deliberate B+ tradeoff: pay a tiny amount of typed
 * boilerplate per repo method, in exchange for zero `// biome-ignore
 * noExplicitAny` and zero widened-`SQLiteTable` plumbing.
 */

/** One deduplicated dep edge to write. */
export interface DepEdge<K extends string> {
  readonly kind: K;
  readonly targetFqn: string;
}

/**
 * Dedupe + skipSelf-apply across every dep-kind. Returns the edges
 * grouped by kind in spec order so the caller can fan out to the
 * correct typed table per kind:
 *
 *     for (const { kind, targetFqn } of dedupedDepEdges(SPECS, deps, fqn)) {
 *       if (kind === "skills") tx.insert(skillSkillDeps).values({ sourceFqn: fqn, targetFqn }).run();
 *       else                  tx.insert(skillMcpDeps).values({ sourceFqn: fqn, targetFqn }).run();
 *     }
 *
 * `for-of` over the result yields each edge once; the caller's
 * `if (kind === ...)` lets TS narrow to the per-kind table type
 * without any cast.
 */
export function dedupedDepEdges<K extends string>(
  specs: readonly DepSpec<K>[],
  deps: Readonly<Record<K, readonly string[]>>,
  sourceFqn: string,
): DepEdge<K>[] {
  const out: DepEdge<K>[] = [];
  for (const spec of specs) {
    const list = deps[spec.kind] ?? [];
    const seen = new Set<string>();
    for (const targetFqn of list) {
      if (spec.skipSelf === true && targetFqn === sourceFqn) continue;
      if (seen.has(targetFqn)) continue;
      seen.add(targetFqn);
      out.push({ kind: spec.kind, targetFqn });
    }
  }
  return out;
}

/**
 * Aggregate a per-kind iterable of `{sourceFqn, targetFqn}` rows into
 * a `Map<sourceFqn, FqnDeps<K>>`. Used by the `findAll` path which
 * loads every dep table in one pass instead of N queries per row.
 *
 * The caller passes one entry per kind, with the rows already typed
 * concretely; this helper is pure shape-mangling.
 */
export function groupDepRowsBySource<K extends string>(
  specs: readonly DepSpec<K>[],
  rowsByKind: Readonly<
    Record<K, readonly { readonly sourceFqn: string; readonly targetFqn: string }[]>
  >,
): Map<string, FqnDeps<K>> {
  const out = new Map<string, FqnDeps<K>>();
  function ensure(sourceFqn: string): Record<K, readonly { fqn: string }[]> {
    const existing = out.get(sourceFqn);
    if (existing !== undefined) {
      // Existing is FqnDeps<K> = Readonly<Record<K, readonly DependencyRef[]>>;
      // cast away readonly only at the local mutation seam.
      return existing as Record<K, readonly { fqn: string }[]>;
    }
    const fresh = emptyDeps(specs) as Record<K, readonly { fqn: string }[]>;
    out.set(sourceFqn, fresh);
    return fresh;
  }
  for (const spec of specs) {
    for (const r of rowsByKind[spec.kind] ?? []) {
      const acc = ensure(r.sourceFqn);
      acc[spec.kind] = [...acc[spec.kind], { fqn: r.targetFqn }];
    }
  }
  return out;
}

/**
 * Aggregate per-kind iterables of `{targetFqn}` rows for a single
 * source fqn (the `listDependencies(fqn)` path).
 */
export function aggregateDepsForFqn<K extends string>(
  specs: readonly DepSpec<K>[],
  rowsByKind: Readonly<Record<K, readonly { readonly targetFqn: string }[]>>,
): FqnDeps<K> {
  const out = {} as Record<K, readonly { fqn: string }[]>;
  for (const spec of specs) {
    out[spec.kind] = (rowsByKind[spec.kind] ?? []).map((r) => ({ fqn: r.targetFqn }));
  }
  return out;
}

/**
 * Normalise the drizzle blob-mode return shape to a `Buffer`.
 * `better-sqlite3` may surface a `Uint8Array` rather than a `Buffer`
 * depending on the platform / driver version; tests and consumers
 * expect `Buffer`.
 */
export function coerceToBuffer(content: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}
