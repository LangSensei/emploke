/**
 * `applyInstall` — execute a {@link ResolveManifest}.
 *
 * Counterpart to {@link resolveInstall}. Walks the manifest in
 * BFS-friendly order (root first, then each level of deps), fetches
 * each node's content via the catalog's {@link FetcherRegistry}, and
 * installs through the appropriate {@link CatalogManager} primitive.
 *
 * Best-effort: failures don't stop the walk. Returns an
 * {@link InstallManifest} listing per-FQN outcomes (`installed`,
 * `skipped`, `failed`).
 */
import type { CatalogManager } from "./manager.js";
import type { ResolveManifest, ResolveNode } from "./resolve.js";

export interface ApplyInstallInput {
  readonly catalog: CatalogManager;
  readonly manifest: ResolveManifest;
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
  const { catalog, manifest } = input;
  const installed: InstalledEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const failed: FailedEntry[] = [];

  for (const node of manifest.nodes) {
    if (node.error) {
      // Resolution flagged this node as failed; surface that as a
      // skip so the caller sees the manifest-level mismatch but
      // doesn't double-report the same error.
      skipped.push({ fqn: node.fqn, reason: "previewed-but-failed" });
      continue;
    }
    try {
      const result = await applyOne(catalog, node);
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

async function applyOne(catalog: CatalogManager, node: ResolveNode): Promise<ApplyOneResult> {
  if (node.status === "already-installed") {
    return { kind: "skipped", entry: { fqn: node.fqn, reason: "already-installed-same-origin" } };
  }
  if (node.kind === "mcp") {
    const fqn = await catalog.installMcpFromOrigin(node.origin, node.specName);
    return { kind: "installed", entry: { fqn, kind: "mcp", origin: node.origin } };
  }
  if (node.kind === "skill") {
    const skill = await catalog.installSkillFromOrigin(node.origin);
    return { kind: "installed", entry: { fqn: skill.name, kind: "skill", origin: node.origin } };
  }
  const agent = await catalog.installAgentFromOrigin(node.origin);
  return { kind: "installed", entry: { fqn: agent.name, kind: "agent", origin: node.origin } };
}
