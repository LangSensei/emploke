import matter from "gray-matter";
import type { EntryFile } from "../fetcher/index.js";
import { normalizeOrigin, parseOrigin } from "../fetcher/index.js";
import { ImmutableOriginError, isOriginMutable } from "../origin-mutability.js";

/**
 * Origin / frontmatter utilities shared by `agent/agent-service.ts`
 * and `skill/skill-service.ts`. Every export here is structural —
 * pure data shapes, pure functions over byte strings, and stateless
 * helpers that name no kind-specific concept.
 *
 * Per-kind workflow (resolve, sibling lookup, plan/conflict types,
 * per-installation state) lives in each kind's own files
 * (`agent/agent-{entity,service}.ts`, `skill/skill-{entity,service}.ts`).
 * Agent and skill are independent kinds with no shared domain methods;
 * duplicating ~30 LOC of resolve workflow per kind beats coupling them
 * through a shared abstraction. See the agent-entity.ts header JSDoc
 * for the maintainer principle.
 */

/** One file pulled from the fetcher tree. Structural shape (`relPath` + `content`). */
export interface AnchoredFile {
  readonly relPath: string;
  readonly content: Buffer;
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

/**
 * Pull every file from the fetcher tree into a `Map<relPath, Buffer>`,
 * surfacing the anchor's bytes separately so the caller can re-validate
 * the version field before persisting. The `fetcher` parameter is a
 * structural `{ fetchTree }` shape — each per-kind service file
 * declares its own `AgentFetcher` / `SkillFetcher` interface that
 * satisfies this shape.
 */
export async function readFetcherTree(
  fetcher: { fetchTree(origin: string): AsyncIterable<EntryFile> },
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
