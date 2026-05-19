import { MigrationCycleError, MigrationDependencyMissingError } from "./errors.js";
import type { Migration } from "./types.js";

/**
 * Stable topological sort of pending migrations.
 *
 * Each migration is a node identified by `"${pkg}:${toVersion}"`. We
 * place two kinds of edges into the graph:
 *
 *   1. **Implicit within-pkg edges.** For each pkg, migration `v(N+1)`
 *      depends on migration `vN`. Without this the coordinator could
 *      try to apply `v3→v4` before `v2→v3` whenever cross-pkg edges
 *      from `dependsOn` placed them in opposite orders.
 *
 *   2. **Explicit cross-pkg edges from {@link Migration.dependsOn}.**
 *      Each entry is `"<pkg>:<toVersion>"` naming a migration this
 *      one must run AFTER. Missing references — naming a node that
 *      is not in the pending set — surface as
 *      {@link MigrationDependencyMissingError} so a typo at author
 *      time never silently slips through.
 *
 * Algorithm is Kahn's: pick zero-indegree nodes, append, decrement
 * indegrees of dependents, repeat. Ties within a single "ready"
 * frontier are broken **stably** by (pkg ASC, fromVersion ASC) so
 * the output is deterministic across runs and across JS engines (we
 * never rely on `Set` / `Map` iteration order for the user-visible
 * sequence).
 *
 * Throws {@link MigrationCycleError} when nodes remain unplaced —
 * `dependsOn` cycles cannot be reconciled and indicate a programmer
 * error, not a recoverable runtime condition.
 */
export function topoSort(migrations: readonly Migration[]): Migration[] {
  if (migrations.length === 0) return [];

  const key = (m: Migration) => `${m.pkg}:${m.toVersion}`;
  const byKey = new Map<string, Migration>();
  for (const m of migrations) {
    byKey.set(key(m), m);
  }

  // Build adjacency: edges go from dependency → dependent (so when a
  // dependency is processed we decrement the dependent's indegree).
  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const m of migrations) {
    indegree.set(key(m), 0);
    dependents.set(key(m), []);
  }
  for (const m of migrations) {
    const myKey = key(m);

    // Implicit within-pkg edge: vN must precede v(N+1). We add the
    // edge only if the predecessor is also in the pending set. A
    // missing predecessor means we're starting from a higher
    // baseline (e.g. coordinator already established v2 in an older
    // boot and only v2→v3 is pending now), which is fine.
    if (m.fromVersion > 0) {
      const predecessor = `${m.pkg}:${m.fromVersion}`;
      if (byKey.has(predecessor)) {
        dependents.get(predecessor)?.push(myKey);
        indegree.set(myKey, (indegree.get(myKey) ?? 0) + 1);
      }
    }

    // Explicit cross-pkg edges.
    for (const dep of m.dependsOn ?? []) {
      if (!byKey.has(dep)) {
        throw new MigrationDependencyMissingError(m, dep);
      }
      // Self-references would short-circuit Kahn's into an
      // unsatisfiable cycle; reject early with the same error class
      // as a normal cycle so the operator sees a single failure
      // mode regardless of arity.
      if (dep === myKey) {
        throw new MigrationCycleError([m]);
      }
      dependents.get(dep)?.push(myKey);
      indegree.set(myKey, (indegree.get(myKey) ?? 0) + 1);
    }
  }

  const compareReady = (a: Migration, b: Migration): number => {
    if (a.pkg !== b.pkg) return a.pkg < b.pkg ? -1 : 1;
    return a.fromVersion - b.fromVersion;
  };

  // Seed the frontier with every zero-indegree node sorted for
  // determinism.
  const ready: Migration[] = [];
  for (const m of migrations) {
    if (indegree.get(key(m)) === 0) ready.push(m);
  }
  ready.sort(compareReady);

  const ordered: Migration[] = [];
  while (ready.length > 0) {
    // Pop the lexically-smallest ready node so order is fully
    // deterministic given the same input set.
    const next = ready.shift() as Migration;
    ordered.push(next);
    const newlyReady: Migration[] = [];
    for (const depKey of dependents.get(key(next)) ?? []) {
      const left = (indegree.get(depKey) ?? 0) - 1;
      indegree.set(depKey, left);
      if (left === 0) {
        const m = byKey.get(depKey);
        if (m) newlyReady.push(m);
      }
    }
    if (newlyReady.length > 0) {
      newlyReady.sort(compareReady);
      // Merge into `ready` while preserving total order. Each side
      // is already sorted so a single merge pass keeps the frontier
      // ordered without an O(n log n) re-sort per iteration.
      const merged: Migration[] = [];
      let i = 0;
      let j = 0;
      while (i < ready.length && j < newlyReady.length) {
        const r = ready[i] as Migration;
        const n = newlyReady[j] as Migration;
        if (compareReady(r, n) <= 0) {
          merged.push(r);
          i++;
        } else {
          merged.push(n);
          j++;
        }
      }
      while (i < ready.length) merged.push(ready[i++] as Migration);
      while (j < newlyReady.length) merged.push(newlyReady[j++] as Migration);
      ready.length = 0;
      ready.push(...merged);
    }
  }

  if (ordered.length !== migrations.length) {
    const placed = new Set(ordered.map(key));
    const remaining = migrations.filter((m) => !placed.has(key(m)));
    throw new MigrationCycleError(remaining);
  }

  return ordered;
}
