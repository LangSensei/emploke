/**
 * FQN grammar mirrors `packages/catalog/src/skill/validate.ts`. Inlined
 * here (rather than imported as a value from `@emploke/catalog`)
 * because:
 *
 *   1. The catalog's public `index.ts` uses `export * as ns from "..."`
 *      namespace re-exports. Per the ESM spec these namespace objects
 *      MUST contain every export of the target module — bundlers
 *      cannot tree-shake any subset out, even if no consumer reads
 *      those properties. A value import therefore pulls the catalog's
 *      entire entity-services graph into the browser bundle,
 *      including `node:fs/promises`, `better-sqlite3`, `tar-stream`,
 *      and other Node-only modules → runtime crash on first render
 *      ("Module 'node:fs/promises' has been externalized for browser
 *      compatibility…").
 *
 *   2. The grammar is ~25 LOC of regex + length checks and hasn't
 *      changed in months. The drift surface is bounded: if the
 *      catalog one day relaxes the grammar, the worst case is
 *      dashboard's strict variant rejects something the catalog
 *      accepts, surfacing as a visible "invalid FQN" UI message —
 *      never silent corruption.
 *
 *   3. Project axiom (`.pilot/strategy.md`):
 *      "Duplication > shared abstraction that locks co-evolution."
 *
 * If the catalog grammar ever changes, update this file AND its
 * companion test (`packages/dashboard/test/fqn.test.ts`) in lockstep.
 */
const SHORT_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SCOPE_RE = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/;
const MAX_SEGMENT_LEN = 64;

function isValidScope(s: string): boolean {
  return s.length > 0 && s.length <= MAX_SEGMENT_LEN && SCOPE_RE.test(s);
}

function isValidShortName(s: string): boolean {
  return s.length > 0 && s.length <= MAX_SEGMENT_LEN && SHORT_NAME_RE.test(s);
}

/**
 * Strict split — returns null if the FQN is malformed (not exactly
 * one `/`, invalid scope, invalid shortName, etc.). Use this in
 * non-render code paths (routing, deep-link parsing) where a
 * malformed value should surface as a typed "missing / unknown" case.
 */
export function splitFqn(fqn: string): { scope: string; shortName: string } | null {
  if (typeof fqn !== "string" || fqn.length === 0) return null;
  const slashIdx = fqn.indexOf("/");
  if (slashIdx === -1) return null;
  if (fqn.indexOf("/", slashIdx + 1) !== -1) return null;
  const scope = fqn.slice(0, slashIdx);
  const shortName = fqn.slice(slashIdx + 1);
  if (!isValidScope(scope) || !isValidShortName(shortName)) return null;
  return { scope, shortName };
}

/**
 * Display-only split — never throws or returns null. Falls back to
 * `{ scope: "", shortName: fqn }` for malformed input so the UI can
 * render SOMETHING instead of crashing. Use this in JSX render paths.
 *
 * Boundary semantics: split on the FIRST `/`. Multi-slash inputs
 * yield scope = leading segment, shortName = the rest.
 */
export function splitFqnForDisplay(fqn: string): { scope: string; shortName: string } {
  const idx = fqn.indexOf("/");
  if (idx < 0) return { scope: "", shortName: fqn };
  return { scope: fqn.slice(0, idx), shortName: fqn.slice(idx + 1) };
}
