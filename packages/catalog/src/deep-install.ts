/**
 * `deepInstall` — recursive origin-driven installer.
 *
 * Walks a root entry's frontmatter dependency graph, fetches each
 * transitive entry from its declared `origin` URI, and installs into the
 * catalog. Returns a structured manifest of `installed` / `skipped` /
 * `failed` per FQN.
 *
 * **Best-effort semantics** (matches the 207 response of the route
 * layer): one failure does not abort the walk. Siblings continue to
 * install; the failure is recorded under `failed[]`.
 *
 * **Dedup**: per-FQN dedup via a `visited` Map. The same FQN reached
 * twice through different parents installs once. The same FQN with
 * conflicting canonical origins fails the second visit (the first one
 * stays installed).
 *
 * **No new locking primitives**: every catalog mutation goes through
 * `CatalogManager.installXxxFromStream`, which already takes the
 * per-catalog write lock for its own scope. Sibling installs run
 * sequentially within one `deepInstall` invocation; concurrent
 * `deepInstall` calls coordinate through the same catalog lock.
 *
 * **Agents are roots only**: `dependencies.agents` is not part of the
 * frontmatter contract. Agents at the root come in via `installAgent` /
 * `installAgentFromStream`; their skill / mcp deps are walked recursively
 * just like skills'.
 */
import {
  type EntryFile,
  type FetcherRegistry,
  normalizeOrigin,
  parseOrigin,
} from "@emploke/catalog-fetcher";
import { OriginConflictError } from "./errors.js";
import { parseFrontmatter } from "./frontmatter.js";
import type { CatalogManager } from "./manager.js";
import type { DependencyRef } from "./types.js";

export type RootKind = "skill" | "agent" | "mcp";

export interface DeepInstallInput {
  readonly catalog: CatalogManager;
  readonly fetchers: FetcherRegistry;
  readonly rootKind: RootKind;
  readonly rootOrigin: string;
  /** Required when rootKind === "mcp"; ignored otherwise. */
  readonly rootMcpName?: string;
  /** Optional scope override (used by mcp installs only). */
  readonly rootScope?: string;
}

export interface InstalledEntry {
  readonly fqn: string;
  readonly kind: RootKind;
  readonly origin: string;
}

export interface SkippedEntry {
  readonly fqn: string;
  readonly reason: "already-installed-same-origin";
}

export interface FailedEntry {
  readonly fqn: string;
  readonly origin: string;
  /** Error name (e.g. `OriginConflictError`, `FetchError`). */
  readonly errorName: string;
  readonly message: string;
}

export interface InstallManifest {
  readonly installed: InstalledEntry[];
  readonly skipped: SkippedEntry[];
  readonly failed: FailedEntry[];
}

/** Internal queue work item. */
interface PendingNode {
  readonly kind: "skill" | "mcp";
  readonly origin: string;
  readonly mcpName?: string;
  readonly scope?: string;
}

/** DependencyRef + the kind discriminator we attach during BFS expansion. */
type TaggedDepRef = DependencyRef & { readonly kind: "skill" | "mcp" };

export async function deepInstall(input: DeepInstallInput): Promise<InstallManifest> {
  const installed: InstalledEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const failed: FailedEntry[] = [];

  // visited.set(fqn, normalizedOrigin) — first canonical origin wins.
  const visited = new Map<string, string>();

  // Special-case the root: agent installs at root, then we walk its deps.
  // Skill installs at root, then we walk its deps. MCPs have no deps so
  // they install once and we're done.
  let rootEntry: { fqn: string; depRefs: TaggedDepRef[] } | null = null;
  try {
    rootEntry = await installRoot(input, installed, visited);
  } catch (err) {
    failed.push(toFailedEntry(rootFqnPreview(input), input.rootOrigin, err));
    return { installed, skipped, failed };
  }
  if (!rootEntry) return { installed, skipped, failed };

  // BFS over deps.
  const queue: PendingNode[] = rootEntry.depRefs.map(taggedDepToPending);
  while (queue.length > 0) {
    const node = queue.shift()!;
    const result = await installOne(input, node, visited);
    if (result.kind === "installed") {
      installed.push(result.entry);
      for (const dep of result.depRefs) queue.push(taggedDepToPending(dep));
    } else if (result.kind === "skipped") {
      skipped.push(result.entry);
    } else {
      failed.push(result.entry);
    }
  }

  return { installed, skipped, failed };
}

function taggedDepToPending(ref: TaggedDepRef): PendingNode {
  const out: PendingNode = { kind: ref.kind, origin: ref.origin };
  if (ref.kind === "mcp") (out as { mcpName?: string }).mcpName = ref.name;
  if (ref.scope !== undefined) (out as { scope?: string }).scope = ref.scope;
  return out;
}

async function installRoot(
  input: DeepInstallInput,
  installed: InstalledEntry[],
  visited: Map<string, string>,
): Promise<{ fqn: string; depRefs: TaggedDepRef[] } | null> {
  const { catalog, fetchers, rootKind, rootOrigin } = input;
  const canonical = normalizeOrigin(parseOrigin(rootOrigin));

  if (rootKind === "mcp") {
    if (!input.rootMcpName) {
      throw new Error("deepInstall(rootKind=mcp) requires rootMcpName");
    }
    const stream = fetchers.dispatch(rootOrigin);
    const content = await readSingleFile(stream);
    const mcpOpts: { mcpName: string; origin: string; scope?: string } = {
      mcpName: input.rootMcpName,
      origin: rootOrigin,
    };
    if (input.rootScope !== undefined) mcpOpts.scope = input.rootScope;
    const fqn = await catalog.installMcpFromContent(content, mcpOpts);
    visited.set(fqn, canonical);
    installed.push({ fqn, kind: "mcp", origin: rootOrigin });
    return { fqn, depRefs: [] };
  }

  const stream = fetchers.dispatch(rootOrigin);
  if (rootKind === "skill") {
    const skill = await catalog.installSkillFromStream(stream, { origin: rootOrigin }, rootOrigin);
    visited.set(skill.name, canonical);
    installed.push({ fqn: skill.name, kind: "skill", origin: rootOrigin });
    return {
      fqn: skill.name,
      depRefs: [
        ...(skill.dependencies?.skills ?? []).map((r) => ({ ...r, kind: "skill" as const })),
        ...(skill.dependencies?.mcps ?? []).map((r) => ({ ...r, kind: "mcp" as const })),
      ],
    };
  }
  // agent
  const agent = await catalog.installAgentFromStream(stream, { origin: rootOrigin }, rootOrigin);
  visited.set(agent.name, canonical);
  installed.push({ fqn: agent.name, kind: "agent", origin: rootOrigin });
  return {
    fqn: agent.name,
    depRefs: [
      ...(agent.dependencies?.skills ?? []).map((r) => ({ ...r, kind: "skill" as const })),
      ...(agent.dependencies?.mcps ?? []).map((r) => ({ ...r, kind: "mcp" as const })),
    ],
  };
}

type InstallOneResult =
  | {
      kind: "installed";
      entry: InstalledEntry;
      depRefs: TaggedDepRef[];
    }
  | { kind: "skipped"; entry: SkippedEntry }
  | { kind: "failed"; entry: FailedEntry };

async function installOne(
  input: DeepInstallInput,
  node: PendingNode,
  visited: Map<string, string>,
): Promise<InstallOneResult> {
  const { catalog, fetchers } = input;

  // Cheap pre-check: if any visited FQN already canonicalises to the same
  // origin, this is a same-origin re-visit → skip without re-fetch. We
  // can't know the FQN until after parse, so we also re-check post-parse
  // before installing.
  let canonicalOrigin: string;
  try {
    canonicalOrigin = normalizeOrigin(parseOrigin(node.origin));
  } catch (err) {
    return {
      kind: "failed",
      entry: toFailedEntry("<unknown>", node.origin, err),
    };
  }

  try {
    if (node.kind === "mcp") {
      const stream = fetchers.dispatch(node.origin);
      const content = await readSingleFile(stream);
      const previewName = node.mcpName;
      if (!previewName) {
        return {
          kind: "failed",
          entry: {
            fqn: "<unknown-mcp>",
            origin: node.origin,
            errorName: "MissingMcpName",
            message: `dep references mcp without name (origin: ${node.origin})`,
          },
        };
      }
      // Pre-flight FQN to dedup before install.
      const previewScope =
        node.scope ?? scopeFromOriginString(node.origin);
      const previewFqn = `${previewScope}/${previewName}`;
      const existingCanonical = visited.get(previewFqn);
      if (existingCanonical !== undefined) {
        if (existingCanonical === canonicalOrigin) {
          return {
            kind: "skipped",
            entry: { fqn: previewFqn, reason: "already-installed-same-origin" },
          };
        }
        return {
          kind: "failed",
          entry: {
            fqn: previewFqn,
            origin: node.origin,
            errorName: "OriginConflictError",
            message: `FQN "${previewFqn}" already installed from a different origin`,
          },
        };
      }
      const mcpOpts: { mcpName: string; origin: string; scope?: string } = {
        mcpName: previewName,
        origin: node.origin,
      };
      if (node.scope !== undefined) mcpOpts.scope = node.scope;
      const fqn = await catalog.installMcpFromContent(content, mcpOpts);
      visited.set(fqn, canonicalOrigin);
      return {
        kind: "installed",
        entry: { fqn, kind: "mcp", origin: node.origin },
        depRefs: [],
      };
    }

    // skill
    const stream = fetchers.dispatch(node.origin);
    // Buffer + peek the SKILL.md frontmatter so we can dedup before mutating.
    const buffered: EntryFile[] = [];
    let anchor: { content: string; sourcePath: string } | null = null;
    for await (const file of stream) {
      buffered.push(file);
      if (file.relPath === "SKILL.md") {
        anchor = { content: file.content.toString("utf8"), sourcePath: `${node.origin}/SKILL.md` };
      }
    }
    if (!anchor) {
      return {
        kind: "failed",
        entry: {
          fqn: "<unknown-skill>",
          origin: node.origin,
          errorName: "MissingAnchor",
          message: `stream from ${node.origin} did not contain SKILL.md`,
        },
      };
    }
    const { data } = parseFrontmatter(anchor.content, anchor.sourcePath);
    const previewScope =
      typeof data.scope === "string" ? data.scope : scopeFromOriginString(node.origin);
    const previewFqn = `${previewScope}/${data.name}`;
    const existingCanonical = visited.get(previewFqn);
    if (existingCanonical !== undefined) {
      if (existingCanonical === canonicalOrigin) {
        return {
          kind: "skipped",
          entry: { fqn: previewFqn, reason: "already-installed-same-origin" },
        };
      }
      return {
        kind: "failed",
        entry: {
          fqn: previewFqn,
          origin: node.origin,
          errorName: "OriginConflictError",
          message: `FQN "${previewFqn}" already installed from a different origin`,
        },
      };
    }
    const skill = await catalog.installSkillFromStream(
      asyncIterableOf(buffered),
      { origin: node.origin },
      node.origin,
    );
    visited.set(skill.name, canonicalOrigin);
    return {
      kind: "installed",
      entry: { fqn: skill.name, kind: "skill", origin: node.origin },
      depRefs: [
        ...(skill.dependencies?.skills ?? []).map((r) => ({ ...r, kind: "skill" as const })),
        ...(skill.dependencies?.mcps ?? []).map((r) => ({ ...r, kind: "mcp" as const })),
      ],
    };
  } catch (err) {
    if (err instanceof OriginConflictError) {
      return {
        kind: "failed",
        entry: {
          fqn: err.fqn,
          origin: node.origin,
          errorName: "OriginConflictError",
          message: err.message,
        },
      };
    }
    return { kind: "failed", entry: toFailedEntry("<unknown>", node.origin, err) };
  }
}

function rootFqnPreview(input: DeepInstallInput): string {
  if (input.rootKind === "mcp" && input.rootMcpName) {
    const scope = input.rootScope ?? scopeFromOriginString(input.rootOrigin);
    return `${scope}/${input.rootMcpName}`;
  }
  return "<root>";
}

function toFailedEntry(fqn: string, origin: string, err: unknown): FailedEntry {
  const e = err instanceof Error ? err : new Error(String(err));
  return { fqn, origin, errorName: e.name, message: e.message };
}

function scopeFromOriginString(uri: string): string {
  // Cheap, swallow errors — caller has already validated. Falling back to
  // "local" matches what scopeFromOrigin does for `file:` URIs.
  try {
    const o = parseOrigin(uri);
    return o.scheme === "file" ? "local" : o.scheme === "github" ? o.owner.toLowerCase() : "local";
  } catch {
    return "local";
  }
}

async function readSingleFile(stream: AsyncIterable<EntryFile>): Promise<string> {
  let result: Buffer | null = null;
  for await (const file of stream) {
    if (result === null) result = file.content;
    // For mcp: we expect exactly one file; ignore extras silently. The
    // fetcher should already filter by subpath if the user pointed at one
    // file inside a tree, but a file:-pointed JSON file always yields one
    // entry; a github subpath-of-one-file likewise.
  }
  if (result === null) throw new Error("stream yielded no files (expected one for mcp install)");
  return result.toString("utf8");
}

async function* asyncIterableOf<T>(items: Iterable<T>): AsyncIterable<T> {
  for (const item of items) yield item;
}
