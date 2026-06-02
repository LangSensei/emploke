/**
 * In-process fake implementing the runtime's `AgentContentSource`
 * port. Replaces the previous `makeTestCatalog` helper (which spun up
 * an in-memory catalog DB and drove the real install pipeline) with a
 * pure value-builder: fixtures are stored in Maps and read directly.
 *
 * Why a fake instead of the real catalog:
 *
 *   1. The runtime is the bottom layer of the package graph; depending
 *      on the catalog (even as a test-only devDep) visually suggests
 *      runtime → catalog coupling that does not exist in production
 *      code.
 *   2. Alt-catalog packages cannot integration-test against runtime
 *      without duplicating fixture infrastructure tied to one catalog
 *      implementation.
 *   3. The fake's narrower surface (no install pipeline, no SQLite,
 *      no `_meta` injection) makes test failures easier to localize.
 *
 * The fake intentionally does NOT:
 *
 *   - Parse `AGENTS.md` / `SKILL.md` frontmatter. Skill / MCP
 *     dependencies are declared in the fixture's `deps` field
 *     explicitly. Tests that previously relied on frontmatter dep
 *     parsing must move those edges to `deps.skills` / `deps.mcps`.
 *   - Inject or strip `_meta`. Fixtures pass through verbatim.
 *     MCP configs must be pre-stripped (runtime-shape).
 *   - Validate FQNs against the catalog's install rules. The fake's
 *     job is to satisfy the runtime's port, not to enforce catalog
 *     authoring conventions.
 *
 * Type imports come from `../../src/types.js` directly; this is a
 * same-package test fixture, not a public API consumer, so reaching
 * across the `src/index.ts` boundary for `AgentContentSource` /
 * `ResolvedAgent` is acceptable (and the only option, since these
 * types are deliberately not re-exported — see the P3 brief
 * Decision #2).
 */
import type { AgentContentSource, ResolvedAgent } from "../../src/types.js";

/**
 * Fixture for a single agent. `files` is a map of relative path →
 * file content; `AGENTS.md` MUST be one of the keys. Sibling files
 * (templates, scripts, hooks) are yielded as-is by `agentEntries`.
 *
 * `deps.skills` / `deps.mcps` declare dependency edges that
 * `resolveAgent` walks to build the skill list and aggregate MCPs.
 * Both arrays accept FQNs in either `<namespace>/<short>` form or
 * bare short names (auto-prefixed with `public/`).
 */
export interface FakeAgentFixture {
  readonly files: Record<string, string>;
  readonly deps?: { readonly skills?: readonly string[]; readonly mcps?: readonly string[] };
}

/**
 * Fixture for a single skill. `files` is a map of relative path →
 * file content; `SKILL.md` MUST be one of the keys. Skill-to-skill
 * cycles via `deps.skills` are detected and surfaced as an `Error`
 * with message prefix `"skill dep cycle: "` followed by the FQN
 * chain that closes the cycle.
 */
export interface FakeSkillFixture {
  readonly files: Record<string, string>;
  readonly deps?: { readonly skills?: readonly string[]; readonly mcps?: readonly string[] };
}

/**
 * Bundle of fixtures handed to `makeFakeContentSource`. Each map is
 * keyed by FQN (or bare short name, auto-prefixed with `public/`).
 * `mcps` values are the runtime-shape config (post-`_meta`-strip).
 */
export interface FakeFixtures {
  readonly agents?: Record<string, FakeAgentFixture>;
  readonly skills?: Record<string, FakeSkillFixture>;
  readonly mcps?: Record<string, Record<string, unknown>>;
}

/**
 * Mirror of `test-catalog.ts`'s `toFqn` so short-name fixtures keep
 * working: bare names get the `public/` namespace prefix; names that
 * already contain `/` are taken verbatim.
 */
function toFqn(name: string): string {
  return name.includes("/") ? name : `public/${name}`;
}

function reKey<T>(input: Record<string, T> | undefined): Map<string, T> {
  const out = new Map<string, T>();
  if (input === undefined) return out;
  for (const [k, v] of Object.entries(input)) out.set(toFqn(k), v);
  return out;
}

/**
 * Recursive DFS that emits skill FQNs in topological order — every
 * skill appears AFTER all skills it depends on. The `visited` set
 * keys on FQN so a skill reachable via both a direct and a
 * transitive path is emitted exactly once. The `stack` array tracks
 * the active recursion stack for cycle detection; revisiting any
 * FQN already on the stack throws an `Error` whose message starts
 * with `"skill dep cycle: "` and lists the closing chain in
 * insertion-to-cycle order.
 *
 * MCP edges discovered while walking skills are accumulated into
 * `mcpFqns` (a set keyed by FQN) so the caller can union them with
 * the agent's own MCP deps and emit a de-duplicated list.
 */
function walkSkills(
  rootFqns: readonly string[],
  skills: Map<string, FakeSkillFixture>,
  mcpFqns: Set<string>,
): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(fqn: string): void {
    if (visited.has(fqn)) return;
    if (stack.includes(fqn)) {
      // The cycle closes from the existing occurrence of `fqn` on
      // the stack back to itself; report the chain so the test can
      // pinpoint the bad edge without inspecting the fixture map.
      const start = stack.indexOf(fqn);
      const chain = [...stack.slice(start), fqn];
      throw new Error(`skill dep cycle: ${chain.join(" -> ")}`);
    }
    const fixture = skills.get(fqn);
    if (fixture === undefined) {
      throw new Error(`skill not found: ${fqn}`);
    }
    stack.push(fqn);
    for (const dep of fixture.deps?.skills ?? []) {
      visit(toFqn(dep));
    }
    stack.pop();
    for (const mcp of fixture.deps?.mcps ?? []) {
      mcpFqns.add(toFqn(mcp));
    }
    visited.add(fqn);
    order.push(fqn);
  }

  for (const fqn of rootFqns) visit(toFqn(fqn));
  return order;
}

/**
 * Build an in-process `AgentContentSource` populated with the given
 * fixtures. The returned `setMcpConfigOverride(fqn, valueOrError)`
 * lets tests inject a per-FQN override: an `Error` instance causes
 * `getMcpRuntimeConfig(fqn)` to reject (driving the
 * `InvalidMcpJson`-wrap path in `provision.ts`); any other value
 * resolves verbatim, overriding the fixture's MCP body.
 *
 * `close()` is a no-op retained for symmetry with the previous
 * `makeTestCatalog` shape — the old helper closed an in-memory
 * SQLite handle here.
 */
export function makeFakeContentSource(fixtures: FakeFixtures = {}): {
  readonly source: AgentContentSource;
  readonly setMcpConfigOverride: (fqn: string, valueOrError: unknown) => void;
  readonly close: () => Promise<void>;
} {
  const agents = reKey(fixtures.agents);
  const skills = reKey(fixtures.skills);
  const mcps = reKey(fixtures.mcps);
  const overrides = new Map<string, unknown>();

  const source: AgentContentSource = {
    async resolveAgent(fqnArg: string): Promise<ResolvedAgent> {
      const fqn = toFqn(fqnArg);
      const fixture = agents.get(fqn);
      if (fixture === undefined) {
        throw new Error(`agent not found: ${fqn}`);
      }
      const mcpSet = new Set<string>();
      for (const m of fixture.deps?.mcps ?? []) mcpSet.add(toFqn(m));
      const skillOrder = walkSkills(fixture.deps?.skills ?? [], skills, mcpSet);
      return {
        agent: { fqn },
        skills: skillOrder.map((f) => ({ skill: { fqn: f } })),
        mcps: [...mcpSet].map((f) => ({ fqn: f })),
      };
    },
    async *agentEntries(fqnArg: string): AsyncIterable<{ relPath: string; content: Buffer }> {
      const fqn = toFqn(fqnArg);
      const fixture = agents.get(fqn);
      if (fixture === undefined) {
        throw new Error(`agent not found: ${fqn}`);
      }
      for (const [relPath, body] of Object.entries(fixture.files)) {
        yield { relPath, content: Buffer.from(body, "utf8") };
      }
    },
    async *skillEntries(fqnArg: string): AsyncIterable<{ relPath: string; content: Buffer }> {
      const fqn = toFqn(fqnArg);
      const fixture = skills.get(fqn);
      if (fixture === undefined) {
        throw new Error(`skill not found: ${fqn}`);
      }
      for (const [relPath, body] of Object.entries(fixture.files)) {
        yield { relPath, content: Buffer.from(body, "utf8") };
      }
    },
    async getMcpRuntimeConfig(fqnArg: string): Promise<Record<string, unknown>> {
      const fqn = toFqn(fqnArg);
      if (overrides.has(fqn)) {
        const v = overrides.get(fqn);
        if (v instanceof Error) throw v;
        return v as Record<string, unknown>;
      }
      const fixture = mcps.get(fqn);
      if (fixture === undefined) {
        throw new Error(`mcp not found: ${fqn}`);
      }
      return fixture;
    },
  };

  return {
    source,
    setMcpConfigOverride(fqnArg: string, valueOrError: unknown): void {
      overrides.set(toFqn(fqnArg), valueOrError);
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}
