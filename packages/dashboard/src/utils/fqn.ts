import { splitFqn as catalogSplitFqn } from "@emploke/catalog";

/**
 * Strict split — returns null if the FQN is malformed (not exactly one
 * `/`, invalid scope, invalid shortName, etc.). Delegates to the
 * canonical `splitFqn` from `@emploke/catalog` to guarantee zero drift
 * over time: when the catalog tightens or relaxes the FQN grammar,
 * dashboard call sites automatically follow.
 *
 * Use this in non-render code paths (routing, deep-link parsing) where
 * a malformed value should surface as a typed "missing / unknown" case.
 */
export function splitFqn(fqn: string): { scope: string; shortName: string } | null {
  try {
    return catalogSplitFqn(fqn);
  } catch {
    return null;
  }
}

/**
 * Display-only split — never throws or returns null. Falls back to
 * `{ scope: "", shortName: fqn }` for malformed input so the UI can
 * render SOMETHING instead of crashing. Use this in JSX render paths.
 *
 * Boundary semantics match the canonical: split on the FIRST `/` so
 * multi-slash inputs (which the model shouldn't produce, but defensive
 * fallback) yield scope = leading segment, shortName = the rest. This
 * matches `@emploke/catalog`'s `splitFqn`; rows render the same way
 * whether the strict or the display helper produced the parts.
 */
export function splitFqnForDisplay(fqn: string): { scope: string; shortName: string } {
  const idx = fqn.indexOf("/");
  if (idx < 0) return { scope: "", shortName: fqn };
  return { scope: fqn.slice(0, idx), shortName: fqn.slice(idx + 1) };
}
