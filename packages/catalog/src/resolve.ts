/**
 * `resolveInstall` — read-only dependency walk for an origin.
 *
 * Returns a {@link ResolveManifest} describing every node in the
 * transitive dep graph: per-FQN status (`new`, `already-installed`,
 * `would-conflict`, `fetch-failed`, `parse-failed`), and the dep edges
 * (`depFqns`) so the dashboard can render the tree.
 *
 * Best-effort: per-node failures don't stop the walk; siblings keep
 * resolving. Per-node failures carry an `error: { name, message }`.
 *
 * Dedup by visited-origin (the cheap key we know before fetching).
 * Two parents that reference the same origin yield one node;
 * post-fetch FQN dedupe is a defensive second layer in
 * {@link applyInstall}.
 *
 * No catalog mutations. Scope comes purely from frontmatter (or
 * default `public`); no scope-mapping system is consulted.
 */
import {
  type EntryFile,
  type FetcherRegistry,
  normalizeOrigin,
  parseOrigin,
} from "@emploke/catalog-fetcher";
import { DEFAULT_SCOPE, parseFrontmatter } from "./frontmatter.js";
import type { CatalogManager } from "./manager.js";
import type { DependencyRef } from "./types.js";
import { makeFqn, validateMcpName } from "./validate.js";

export type RootKind = "skill" | "agent" | "mcp";

export interface ResolveInstallInput {
  readonly catalog: CatalogManager;
  readonly rootKind: RootKind;
  readonly rootOrigin: string;
  /** Required when rootKind === "mcp" — the spec FQN to install under. */
  readonly rootMcpName?: string;
}

export type NodeStatus =
  | "new"
  | "already-installed"
  | "would-conflict"
  | "fetch-failed"
  | "parse-failed";

export interface ResolveNodeError {
  readonly name: string;
  readonly message: string;
}

interface CommonNode {
  readonly origin: string;
  readonly fqn: string;
  readonly status: NodeStatus;
  readonly depFqns: readonly string[];
  readonly error?: ResolveNodeError;
}

export interface SkillResolveNode extends CommonNode {
  readonly kind: "skill";
  readonly shortName: string;
  /** Scope as resolved from frontmatter (or DEFAULT_SCOPE if omitted). */
  readonly scope: string;
  /** True iff frontmatter omitted `scope:` and we used the default. */
  readonly scopeIsDefault: boolean;
}

export interface AgentResolveNode extends CommonNode {
  readonly kind: "agent";
  readonly shortName: string;
  readonly scope: string;
  readonly scopeIsDefault: boolean;
}

export interface McpResolveNode extends CommonNode {
  readonly kind: "mcp";
  readonly specName: string;
}

export type ResolveNode = SkillResolveNode | AgentResolveNode | McpResolveNode;

export interface ResolveManifest {
  readonly rootFqn: string;
  readonly nodes: readonly ResolveNode[];
}

interface PendingNode {
  readonly kind: RootKind;
  readonly origin: string;
  /** Required for MCP nodes (the spec FQN from the parent's dep ref). */
  readonly mcpName?: string;
}

export async function resolveInstall(input: ResolveInstallInput): Promise<ResolveManifest> {
  const { catalog, rootKind, rootOrigin, rootMcpName } = input;
  const fetchers = catalog.fetchers;

  const nodes = new Map<string, ResolveNode>();
  const visitedOrigins = new Set<string>();
  const visitedMcpNames = new Set<string>();

  const queue: PendingNode[] = [];
  const pendingRoot: PendingNode =
    rootKind === "mcp"
      ? rootMcpName !== undefined
        ? { kind: "mcp", origin: rootOrigin, mcpName: rootMcpName }
        : { kind: "mcp", origin: rootOrigin }
      : { kind: rootKind, origin: rootOrigin };
  queue.push(pendingRoot);

  let rootFqn: string | null = null;

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    if (next.kind === "mcp") {
      const name = next.mcpName ?? "";
      if (visitedMcpNames.has(name)) continue;
      visitedMcpNames.add(name);
      const node = await resolveMcpNode(catalog, next.origin, name);
      nodes.set(node.fqn, node);
      if (rootFqn === null) rootFqn = node.fqn;
      continue;
    }
    if (visitedOrigins.has(next.origin)) continue;
    visitedOrigins.add(next.origin);
    const result = await resolveSkillOrAgentNode(catalog, fetchers, next.kind, next.origin);
    nodes.set(result.node.fqn, result.node);
    if (rootFqn === null) rootFqn = result.node.fqn;
    for (const dep of result.children) queue.push(dep);
  }

  return { rootFqn: rootFqn ?? previewRootFqn(input), nodes: [...nodes.values()] };
}

async function resolveMcpNode(
  catalog: CatalogManager,
  origin: string,
  name: string,
): Promise<McpResolveNode> {
  try {
    validateMcpName(name);
  } catch (err) {
    return failedMcpNode(origin, name || "<unknown>", err);
  }
  const status = checkSameOrigin(catalog, name, origin);
  return {
    kind: "mcp",
    origin,
    fqn: name,
    specName: name,
    status,
    depFqns: [],
  };
}

interface SkillOrAgentResolveResult {
  readonly node: SkillResolveNode | AgentResolveNode;
  readonly children: PendingNode[];
}

async function resolveSkillOrAgentNode(
  catalog: CatalogManager,
  fetchers: FetcherRegistry,
  kind: "skill" | "agent",
  origin: string,
): Promise<SkillOrAgentResolveResult> {
  const anchorName = kind === "skill" ? "SKILL.md" : "AGENTS.md";
  let anchor: string;
  try {
    const stream = fetchers.dispatch(origin);
    anchor = await readAnchorFromStream(stream, anchorName);
  } catch (err) {
    return { node: failedSkillOrAgentNode(kind, origin, err), children: [] };
  }
  let data: Record<string, unknown>;
  try {
    ({ data } = parseFrontmatter(anchor, `${origin}/${anchorName}`));
  } catch (err) {
    return { node: failedSkillOrAgentNode(kind, origin, err), children: [] };
  }

  const shortName = typeof data.name === "string" ? data.name : "";
  if (shortName.length === 0) {
    return {
      node: failedSkillOrAgentNode(kind, origin, new Error(`${anchorName} missing \`name\` field`)),
      children: [],
    };
  }

  const inlineScope = typeof data.scope === "string" && data.scope.length > 0 ? data.scope : null;
  const scope = inlineScope ?? DEFAULT_SCOPE;
  const scopeIsDefault = inlineScope === null;

  let fqn: string;
  try {
    fqn = makeFqn(scope, shortName);
  } catch (err) {
    return { node: failedSkillOrAgentNode(kind, origin, err), children: [] };
  }

  const skillDeps = pickDepRefs(data.dependencies, "skills");
  const mcpDeps = pickDepRefs(data.dependencies, "mcps");
  const depFqns = [
    ...skillDeps.map((r) => makeFqnQuiet(r.scope ?? DEFAULT_SCOPE, r.name)),
    ...mcpDeps.map((r) => r.name),
  ];

  const status = checkSameOrigin(catalog, fqn, origin);
  const baseNode = {
    origin,
    fqn,
    shortName,
    scope,
    scopeIsDefault,
    status,
    depFqns,
  };
  const node: SkillResolveNode | AgentResolveNode =
    kind === "skill" ? { kind: "skill", ...baseNode } : { kind: "agent", ...baseNode };

  const children: PendingNode[] = [
    ...skillDeps.map((r) => ({ kind: "skill" as const, origin: r.origin })),
    ...mcpDeps.map((r) => ({ kind: "mcp" as const, origin: r.origin, mcpName: r.name })),
  ];
  return { node, children };
}

function pickDepRefs(raw: unknown, field: "skills" | "mcps"): readonly DependencyRef[] {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return [];
  const arr = (raw as Record<string, unknown>)[field];
  if (!Array.isArray(arr)) return [];
  const out: DependencyRef[] = [];
  for (const item of arr) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const ref = item as Record<string, unknown>;
    if (typeof ref.name !== "string" || typeof ref.origin !== "string") continue;
    const dep: DependencyRef = { name: ref.name, origin: ref.origin };
    if (typeof ref.scope === "string") (dep as { scope?: string }).scope = ref.scope;
    out.push(dep);
  }
  return out;
}

function checkSameOrigin(catalog: CatalogManager, fqn: string, origin: string): NodeStatus {
  let existing: { origin: string } | null = null;
  const skill = catalog.getSkill(fqn);
  if (skill) existing = { origin: skill.origin };
  else {
    const agent = catalog.getAgent(fqn);
    if (agent) existing = { origin: agent.origin };
    else {
      const mcp = catalog.getMcp(fqn);
      if (mcp) existing = { origin: mcp.origin };
    }
  }
  if (existing === null) return "new";
  try {
    const a = normalizeOrigin(parseOrigin(existing.origin));
    const b = normalizeOrigin(parseOrigin(origin));
    return a === b ? "already-installed" : "would-conflict";
  } catch {
    return "would-conflict";
  }
}

function failedSkillOrAgentNode(
  kind: "skill" | "agent",
  origin: string,
  err: unknown,
): SkillResolveNode | AgentResolveNode {
  const e = err instanceof Error ? err : new Error(String(err));
  const base = {
    origin,
    fqn: `__failed__:${kind}:${origin}`,
    shortName: "",
    scope: "",
    scopeIsDefault: false,
    status: classifyError(e),
    depFqns: [] as readonly string[],
    error: { name: e.name, message: e.message },
  };
  return kind === "skill" ? { kind: "skill", ...base } : { kind: "agent", ...base };
}

function failedMcpNode(origin: string, name: string, err: unknown): McpResolveNode {
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    kind: "mcp",
    origin,
    fqn: name,
    specName: name,
    status: classifyError(e),
    depFqns: [],
    error: { name: e.name, message: e.message },
  };
}

function classifyError(err: Error): NodeStatus {
  if (err.name === "FetchError" || err.name === "OriginParseError") return "fetch-failed";
  if (
    err.name === "FrontmatterError" ||
    err.name === "InvalidMcpJsonError" ||
    err.name === "NameInvalid" ||
    err.name === "McpNameInvalidError"
  )
    return "parse-failed";
  return "fetch-failed";
}

function previewRootFqn(input: ResolveInstallInput): string {
  if (input.rootKind === "mcp") return input.rootMcpName ?? "<unknown-mcp>";
  return `__failed__:${input.rootKind}:${input.rootOrigin}`;
}

function makeFqnQuiet(scope: string, name: string): string {
  try {
    return makeFqn(scope, name);
  } catch {
    return `${scope}/${name}`;
  }
}

async function readAnchorFromStream(
  stream: AsyncIterable<EntryFile>,
  anchorName: string,
): Promise<string> {
  for await (const file of stream) {
    if (file.relPath === anchorName) {
      return file.content.toString("utf8");
    }
  }
  throw new Error(`stream did not contain ${anchorName}`);
}
