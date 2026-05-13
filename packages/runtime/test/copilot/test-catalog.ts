import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type AgentResolveResult, CatalogManager } from "@emploke/catalog";

/**
 * Build a `CatalogManager` backed by a SQLite database in a temp dir,
 * with optional fixtures pre-installed.
 *
 * Each fixture entry is a map of relative paths → file contents.
 * AGENTS.md / SKILL.md must be present where applicable. The helper
 * writes fixtures into a temporary "source" directory (one per
 * entry), then drives `catalog.installAgentFromOrigin` /
 * `installSkillFromOrigin` / `installMcp` to register them through
 * the normal install path. This keeps test fixtures honest — they
 * exercise the real install flow rather than bypassing it.
 *
 * Fixture keys MAY be either short names (auto-prefixed with
 * `public/`) or full FQNs (`scope/name`). MCP fixture keys MUST be
 * full MCP-spec FQNs (`<namespace>/<short>`).
 */
export interface TestCatalogFixtures {
  agents?: Record<string, Record<string, string>>;
  skills?: Record<string, Record<string, string>>;
  mcps?: Record<string, string>;
}

function toFqn(name: string): string {
  return name.includes("/") ? name : `public/${name}`;
}

function ensureMcpMeta(content: string, fqn: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return content;
  const obj = parsed as Record<string, unknown>;
  const existing =
    obj._meta !== null && typeof obj._meta === "object" && !Array.isArray(obj._meta)
      ? (obj._meta as Record<string, unknown>)
      : {};
  obj._meta = { ...existing, name: fqn };
  return JSON.stringify(obj);
}

export async function makeTestCatalog(
  fixtures: TestCatalogFixtures = {},
  sourceRootArg?: string,
): Promise<{
  catalog: CatalogManager;
  /** Underlying SQLite connection backing the catalog. Tests can close it in cleanup. */
  db: DatabaseSync;
  /**
   * Test-only helper: write garbage bytes into the SQLite-stored
   * content for an installed MCP, simulating an out-of-band data
   * corruption between scan and read. Bypasses the catalog's normal
   * mutation API (which validates) by issuing a direct SQL UPDATE.
   */
  corruptMcp: (specName: string, content: string) => Promise<void>;
}> {
  const sourceRoot = sourceRootArg ?? (await mkdtemp(path.join(tmpdir(), "test-catalog-src-")));

  // In-memory DB so tests don't litter tmpdir with catalog.db files
  // and Windows EBUSY on cleanup is impossible.
  const db = new DatabaseSync(":memory:");
  const catalog = await CatalogManager.open({ db });

  // Materialise each fixture as a tiny on-disk source dir so the
  // installer can fetch it via `file:` and run its full validation.
  // Order matters: mcps first (skill/agent deps may reference them),
  // then skills (agent deps may reference them), then agents.
  for (const [fqn, content] of Object.entries(fixtures.mcps ?? {})) {
    if (!fqn.includes("/")) {
      throw new Error(
        `MCP fixture "${fqn}" must use spec FQN <namespace>/<short> (e.g. "github/cli")`,
      );
    }
    const filePath = path.join(sourceRoot, "mcps", `${fqn.replace("/", "_")}.json`);
    await mkdir(path.dirname(filePath), { recursive: true });
    const origin = `file:${filePath}`;
    await writeFile(filePath, ensureMcpMeta(content, fqn), "utf8");
    await catalog.installMcpFromOrigin(origin);
  }
  for (const [shortOrFqn, files] of Object.entries(fixtures.skills ?? {})) {
    const fqn = toFqn(shortOrFqn);
    const [, shortName] = fqn.split("/");
    const dir = path.join(sourceRoot, "skills", shortName!);
    await mkdir(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, ...rel.split("/"));
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }
    await catalog.installSkillFromOrigin(`file:${dir}`);
  }
  for (const [shortOrFqn, files] of Object.entries(fixtures.agents ?? {})) {
    const fqn = toFqn(shortOrFqn);
    const [, shortName] = fqn.split("/");
    const dir = path.join(sourceRoot, "agents", shortName!);
    await mkdir(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, ...rel.split("/"));
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }
    await catalog.installAgentFromOrigin(`file:${dir}`);
  }

  const corruptMcp = async (specName: string, content: string): Promise<void> => {
    db.prepare("UPDATE mcp SET content = ? WHERE name = ?").run(content, specName);
    // CatalogManager has no in-memory snapshot, so the next direct read
    // via getMcpContent picks up the corrupted bytes immediately.
  };

  return { catalog, db, corruptMcp };
}

/** Build an `AgentResolveResult` from a catalog plus a name. */
export function resolveTestAgent(
  catalog: CatalogManager,
  name: string,
): Promise<AgentResolveResult> {
  return catalog.resolveAgent(name);
}

/** Re-export so callers don't need a second import. */
export type { AgentResolveResult };
