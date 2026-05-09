import { CycleDetected, MissingDependencies } from "./errors.js";

/**
 * Minimal interface satisfied by any catalog node participating in the graph.
 *
 * Both Skill and MCP adapt to this shape inside the Catalog implementation;
 * `dependencies` is a flat list of FQN strings (`<scope>/<short>`) — the
 * catalog flattens its rich `DependencyRef[]` to FQN strings via
 * `depRefToFqn` at the boundary so this module stays string-keyed and
 * topologically simple.
 */
export interface GraphNode {
  readonly name: string;
  readonly dependencies: readonly string[];
}

/**
 * DFS-based topological sort.
 *
 * Returns nodes reachable from `roots` in dependency-first order: every node
 * appears after all of its (transitive) dependencies. Roots that share
 * dependencies are de-duplicated.
 *
 * Throws:
 *  - {@link CycleDetected}      if a back-edge is found during traversal
 *  - {@link MissingDependencies} if any visited name is absent from `lookup`
 */
export function resolveTopological<N extends GraphNode>(
  roots: readonly string[],
  lookup: (name: string) => N | undefined,
): readonly N[] {
  const result: N[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const start = path.indexOf(name);
      throw new CycleDetected([...path.slice(start), name]);
    }
    const node = lookup(name);
    if (!node) {
      throw new MissingDependencies([name]);
    }
    visiting.add(name);
    path.push(name);
    for (const dep of node.dependencies) {
      visit(dep);
    }
    path.pop();
    visiting.delete(name);
    visited.add(name);
    result.push(node);
  };

  for (const root of roots) {
    visit(root);
  }
  return result;
}

/**
 * Return all nodes that directly depend on `target`. (Not transitive — only
 * one hop. Sufficient for uninstall safety: if anyone depends on the target,
 * uninstall is blocked regardless of how deep the chain goes.)
 */
export function findDirectDependents<N extends GraphNode>(
  target: string,
  allNodes: Iterable<N>,
): readonly N[] {
  const out: N[] = [];
  for (const n of allNodes) {
    if (n.dependencies.includes(target)) {
      out.push(n);
    }
  }
  return out;
}
