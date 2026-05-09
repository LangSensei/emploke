/**
 * `applyInstall` — execute a {@link ResolveManifest}.
 *
 * Counterpart to {@link resolveInstall}. Walks the manifest in BFS-friendly
 * order (root first, then each level of deps), fetches each node's
 * content via the {@link FetcherRegistry}, and installs through the
 * appropriate {@link CatalogManager} primitive.
 *
 * `scopeHints` lets the caller override the resolver-derived scope on
 * a per-node basis. Keys are the FQNs as produced by `resolveInstall`
 * (i.e. `defaultScope/shortName`), values are the desired scope. Only
 * applied to skill/agent nodes — MCPs ignore hints (`editable: false`).
 *
 * Best-effort: failures don't stop the walk. Returns an
 * {@link InstallManifest} listing per-FQN outcomes (`installed`,
 * `skipped`, `failed`) — same shape `deepInstall` used to produce.
 */
import { type FetcherRegistry, type EntryFile } from "@emploke/catalog-fetcher";
import type { CatalogManager } from "./manager.js";
import type { ResolveManifest, ResolveNode } from "./resolve.js";

export interface ApplyInstallInput {
  readonly catalog: CatalogManager;
  readonly fetchers: FetcherRegistry;
  readonly manifest: ResolveManifest;
  /** FQN → scope override, sparse. Only honored for skill/agent nodes. */
  readonly scopeHints?: Readonly<Record<string, string>>;
}

export interface InstalledEntry {
  readonly fqn: string;
  readonly kind: "skill" | "agent" | "mcp";
  readonly origin: string;
}

export interface SkippedEntry {
  readonly fqn: string;
  readonly reason: "already-installed-same-origin" | "previewed-but-failed";
}

export interface FailedEntry {
  readonly fqn: string;
  readonly origin: string;
  readonly errorName: string;
  readonly message: string;
}

export interface InstallManifest {
  readonly installed: InstalledEntry[];
  readonly skipped: SkippedEntry[];
  readonly failed: FailedEntry[];
}

export async function applyInstall(input: ApplyInstallInput): Promise<InstallManifest> {
  const { catalog, fetchers, manifest, scopeHints } = input;
  const installed: InstalledEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const failed: FailedEntry[] = [];

  // Order matters only insofar as a parent must install BEFORE the
  // catalog computes its own resolve graph against the dep — which
  // happens lazily on resolveAgent/resolveSkill. Apply order doesn't
  // need to be topological; the catalog tolerates installing children
  // first. We process in manifest-order (root first) for predictable
  // logs.
  for (const node of manifest.nodes) {
    if (node.error) {
      // Resolution flagged this node as failed; surface that as a
      // skip so the caller sees the manifest-level mismatch but
      // doesn't double-report the same error.
      skipped.push({ fqn: node.fqn, reason: "previewed-but-failed" });
      continue;
    }
    try {
      const result = await applyOne(catalog, fetchers, node, scopeHints);
      if (result.kind === "installed") installed.push(result.entry);
      else skipped.push(result.entry);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      failed.push({
        fqn: node.fqn,
        origin: node.origin,
        errorName: e.name,
        message: e.message,
      });
    }
  }

  return { installed, skipped, failed };
}

type ApplyOneResult =
  | { kind: "installed"; entry: InstalledEntry }
  | { kind: "skipped"; entry: SkippedEntry };

async function applyOne(
  catalog: CatalogManager,
  fetchers: FetcherRegistry,
  node: ResolveNode,
  scopeHints: Readonly<Record<string, string>> | undefined,
): Promise<ApplyOneResult> {
  if (node.status === "already-installed") {
    return { kind: "skipped", entry: { fqn: node.fqn, reason: "already-installed-same-origin" } };
  }
  if (node.kind === "mcp") {
    const stream = fetchers.dispatch(node.origin);
    const content = await readSingleFile(stream);
    const fqn = await catalog.installMcp(content, { name: node.specName, origin: node.origin });
    return { kind: "installed", entry: { fqn, kind: "mcp", origin: node.origin } };
  }
  const stream = fetchers.dispatch(node.origin);
  const hint = scopeHints?.[node.fqn];
  const installOpts: { origin: string; scopeOverride?: string } = { origin: node.origin };
  if (hint !== undefined) installOpts.scopeOverride = hint;
  if (node.kind === "skill") {
    const skill = await catalog.installSkillFromStream(stream, installOpts, node.origin);
    return { kind: "installed", entry: { fqn: skill.name, kind: "skill", origin: node.origin } };
  }
  const agent = await catalog.installAgentFromStream(stream, installOpts, node.origin);
  return { kind: "installed", entry: { fqn: agent.name, kind: "agent", origin: node.origin } };
}

async function readSingleFile(stream: AsyncIterable<EntryFile>): Promise<string> {
  let result: Buffer | null = null;
  for await (const file of stream) {
    if (result === null) result = file.content;
  }
  if (result === null) throw new Error("stream yielded no files (expected one for mcp install)");
  return result.toString("utf8");
}
