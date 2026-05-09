/**
 * `resolveInstall` — read-only dependency walk for an origin.
 *
 * Returns a {@link ResolveManifest} describing every node in the
 * transitive dep graph: per-FQN status (`new`, `already-installed`,
 * `would-conflict`, `fetch-failed`, `parse-failed`), the L1/L2/L3-derived
 * default scope, and the dep edges (`depFqns`) so the dashboard can
 * render the tree.
 *
 * Best-effort: per-node failures don't stop the walk; siblings keep
 * resolving. Per-node failures carry an `error: { name, message }`.
 *
 * Dedup by visited-origin (the cheap key we know before fetching).
 * Two parents that reference the same origin yield one node;
 * post-fetch FQN dedupe is a defensive second layer in
 * {@link applyInstall}.
 *
 * No catalog mutations; the {@link ScopeResolver} is consulted via
 * its read-only `preview()` method (no L3 → L2 auto-write).
 */
import {
  type EntryFile,
  type FetcherRegistry,
  normalizeOrigin,
  parseOrigin,
} from "@emploke/catalog-fetcher";
import { parseFrontmatter } from "./frontmatter.js";
import type { CatalogManager } from "./manager.js";
import type { ScopeResolver } from "./scope-resolver.js";
import type { DependencyRef } from "./types.js";
import { makeFqn, validateMcpName } from "./validate.js";

export type RootKind = "skill" | "agent" | "mcp";

export interface ResolveInstallInput {
  readonly catalog: CatalogManager;
  readonly fetchers: FetcherRegistry;
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
  /** True for skill/agent (scope can be edited); false for MCP. */
  readonly editable: boolean;
  readonly error?: ResolveNodeError;
}

export interface SkillResolveNode extends CommonNode {
  readonly kind: "skill";
  readonly shortName: string;
  readonly defaultScope: string;
  readonly scopeSource: "L1" | "L2" | "L3";
  readonly matchedPattern?: string;
}

export interface AgentResolveNode extends CommonNode {
  readonly kind: "agent";
  readonly shortName: string;
  readonly defaultScope: string;
  readonly scopeSource: "L1" | "L2" | "L3";
  readonly matchedPattern?: string;
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
  const { catalog, fetchers, rootKind, rootOrigin, rootMcpName } = input;
  const scopes = catalog.scopes;

  // Order-preserving result list keyed by FQN. We push the root first
  // so it lands at index 0 even if its children resolve faster.
  const nodes = new Map<string, ResolveNode>();
  // De-dup keys: we visit each origin (skill/agent) or each spec name (mcp) once.
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
    const result = await resolveSkillOrAgentNode(catalog, fetchers, scopes, next.kind, next.origin);
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
    editable: false,
  };
}

interface SkillOrAgentResolveResult {
  readonly node: SkillResolveNode | AgentResolveNode;
  readonly children: PendingNode[];
}

async function resolveSkillOrAgentNode(
  catalog: CatalogManager,
  fetchers: FetcherRegistry,
  scopes: ScopeResolver,
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
  let frontmatterErr: unknown = null;
  try {
    ({ data } = parseFrontmatter(anchor, `${origin}/${anchorName}`));
  } catch (err) {
    frontmatterErr = err;
    data = {};
  }
  if (frontmatterErr !== null) {
    return { node: failedSkillOrAgentNode(kind, origin, frontmatterErr), children: [] };
  }

  const shortName = typeof data.name === "string" ? data.name : "";
  if (shortName.length === 0) {
    return {
      node: failedSkillOrAgentNode(kind, origin, new Error(`${anchorName} missing \`name\` field`)),
      children: [],
    };
  }

  // L1 inline > L2/L3 preview.
  let scope: string;
  let scopeSource: "L1" | "L2" | "L3";
  let matchedPattern: string | undefined;
  if (typeof data.scope === "string" && data.scope.length > 0) {
    scope = data.scope;
    scopeSource = "L1";
  } else {
    try {
      const resolved = scopes.preview(origin);
      scope = resolved.scope;
      scopeSource = resolved.source;
      matchedPattern = resolved.matchedPattern;
    } catch (err) {
      return { node: failedSkillOrAgentNode(kind, origin, err), children: [] };
    }
  }

  let fqn: string;
  try {
    fqn = makeFqn(scope, shortName);
  } catch (err) {
    return { node: failedSkillOrAgentNode(kind, origin, err), children: [] };
  }

  const skillDeps = pickDepRefs(data.dependencies, "skills");
  const mcpDeps = pickDepRefs(data.dependencies, "mcps");
  const depFqns = [
    ...skillDeps.map((r) => makeFqnQuiet(r.scope ?? scopes.preview(r.origin).scope, r.name)),
    ...mcpDeps.map((r) => r.name),
  ];

  const status = checkSameOrigin(catalog, fqn, origin);
  const baseNode = {
    origin,
    fqn,
    shortName,
    defaultScope: scope,
    scopeSource,
    ...(matchedPattern !== undefined ? { matchedPattern } : {}),
    status,
    depFqns,
    editable: true,
  };
  const node: SkillResolveNode | AgentResolveNode =
    kind === "skill" ? { kind: "skill", ...baseNode } : { kind: "agent", ...baseNode };

  const children: PendingNode[] = [
    ...skillDeps.map((r) => ({ kind: "skill" as const, origin: r.origin })),
    ...mcpDeps.map((r) => ({ kind: "mcp" as const, origin: r.origin, mcpName: r.name })),
  ];
  return { node, children };
}

function pickDepRefs(
  raw: unknown,
  field: "skills" | "mcps",
): readonly DependencyRef[] {
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
    defaultScope: "",
    scopeSource: "L3" as const,
    status: classifyError(e),
    depFqns: [] as readonly string[],
    editable: false,
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
    editable: false,
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
