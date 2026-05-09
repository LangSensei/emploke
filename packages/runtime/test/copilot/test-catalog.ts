import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentResolveResult, type CatalogEntryFile, CatalogManager } from "@emploke/catalog";
import {
  InMemoryAgentRepository,
  InMemoryMcpRepository,
  InMemorySkillRepository,
} from "@emploke/catalog/testing";

/**
 * Build a `CatalogManager` backed by in-memory repositories, with optional
 * fixtures pre-installed. Tests use this instead of touching a real
 * filesystem catalog when all they need is "the runtime can pull this
 * agent's bytes".
 *
 * Each fixture is a map of relative paths to file contents. AGENTS.md /
 * SKILL.md must be present in the agent / skill fixtures respectively.
 *
 * Fixture keys MAY be either short names (auto-prefixed with `local/`)
 * or full FQNs (`scope/name`). The scan-time origin synthesis runs
 * `scopeFromOrigin(file:memory:…)` → `local`, so the in-memory repo
 * MUST be seeded under the FQN that scan will compute — otherwise the
 * catalog sees `local/<name>` in its in-memory cache but the repo's
 * storage map is keyed by the raw `<name>`, breaking every subsequent
 * read/write through the FQN.
 */
export interface TestCatalogFixtures {
  agents?: Record<string, Record<string, string>>;
  skills?: Record<string, Record<string, string>>;
  mcps?: Record<string, string>;
}

function toFqn(name: string): string {
  return name.includes("/") ? name : `local/${name}`;
}

export async function makeTestCatalog(fixtures: TestCatalogFixtures = {}): Promise<{
  catalog: CatalogManager;
  repos: {
    agents: InMemoryAgentRepository;
    skills: InMemorySkillRepository;
    mcps: InMemoryMcpRepository;
  };
}> {
  const agentRepo = new InMemoryAgentRepository();
  const skillRepo = new InMemorySkillRepository();
  const mcpRepo = new InMemoryMcpRepository();

  // Pre-seed each repo via its async write surface so the catalog's open()
  // scan finds the entries. We bypass installFromDir here because in-memory
  // repos already accept arbitrary trees per-entry.
  for (const [shortOrFqn, files] of Object.entries(fixtures.agents ?? {})) {
    const name = toFqn(shortOrFqn);
    for (const [rel, content] of Object.entries(files)) {
      const buf = Buffer.from(content, "utf8");
      // The first AGENTS.md write seeds the entry; subsequent paths add files.
      const file = (
        agentRepo as unknown as {
          files: (n: string) => Map<string, Buffer> | null;
        }
      ).files(name);
      if (rel === "AGENTS.md") await agentRepo.write(name, content);
      else if (file) file.set(rel, buf);
      else {
        // Unusual: caller listed sibling files before AGENTS.md. Seed
        // AGENTS.md as empty placeholder so the entry slot exists, then add.
        await agentRepo.write(name, "");
        const seeded = (
          agentRepo as unknown as {
            files: (n: string) => Map<string, Buffer> | null;
          }
        ).files(name);
        seeded?.set(rel, buf);
      }
    }
  }

  for (const [shortOrFqn, files] of Object.entries(fixtures.skills ?? {})) {
    const name = toFqn(shortOrFqn);
    for (const [rel, content] of Object.entries(files)) {
      const buf = Buffer.from(content, "utf8");
      if (rel === "SKILL.md") await skillRepo.write(name, content);
      else {
        const seeded = (
          skillRepo as unknown as {
            files: (n: string) => Map<string, Buffer> | null;
          }
        ).files(name);
        if (!seeded) {
          await skillRepo.write(name, "");
        }
        const after = (
          skillRepo as unknown as {
            files: (n: string) => Map<string, Buffer> | null;
          }
        ).files(name);
        after?.set(rel, buf);
      }
    }
  }

  for (const [shortOrFqn, content] of Object.entries(fixtures.mcps ?? {})) {
    await mcpRepo.write(toFqn(shortOrFqn), content);
  }

  // CatalogManager.open() needs a catalogDir for its stale-lock cleanup.
  // Even with in-memory repos that path is created (mkdir/recursive), so
  // we hand it a tmpdir and forget about it.
  const tmp = await mkdtemp(path.join(tmpdir(), "test-catalog-"));
  const catalog = await CatalogManager.open({
    catalogDir: tmp,
    repositories: { agents: agentRepo, skills: skillRepo, mcps: mcpRepo },
  });
  return { catalog, repos: { agents: agentRepo, skills: skillRepo, mcps: mcpRepo } };
}

/** Build an `AgentResolveResult` from a catalog plus a name. */
export function resolveTestAgent(catalog: CatalogManager, name: string): AgentResolveResult {
  return catalog.resolveAgent(name);
}

/** Re-export so callers don't need a second import. */
export type { AgentResolveResult, CatalogEntryFile };
