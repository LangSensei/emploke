import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

function ensureMcpMeta(content: string, fqn: string, origin: string): string {
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
  obj._meta = { ...existing, name: fqn, origin: existing.origin ?? origin };
  return JSON.stringify(obj);
}

export async function makeTestCatalog(
  fixtures: TestCatalogFixtures = {},
  sourceRootArg?: string,
): Promise<{
  catalog: CatalogManager;
  catalogDir: string;
  /**
   * Test-only helper: write garbage bytes into the SQLite-stored
   * content for an installed MCP, simulating an out-of-band data
   * corruption between scan and read. Bypasses the catalog's normal
   * mutation API (which validates) by issuing a direct SQL UPDATE.
   */
  corruptMcp: (specName: string, content: string) => Promise<void>;
}> {
  const catalogDir = await mkdtemp(path.join(tmpdir(), "test-catalog-"));
  const sourceRoot = sourceRootArg ?? (await mkdtemp(path.join(tmpdir(), "test-catalog-src-")));

  const catalog = await CatalogManager.open({ catalogDir });

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
    await writeFile(filePath, ensureMcpMeta(content, fqn, origin), "utf8");
    await catalog.installMcpFromOrigin(origin, fqn);
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

  await catalog.rescan();

  const corruptMcp = async (specName: string, content: string): Promise<void> => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(catalogDir, "catalog.db"));
    db.prepare("UPDATE mcp SET content = ? WHERE name = ?").run(content, specName);
    db.close();
    // No rescan: the catalog's in-memory cache still believes the MCP
    // exists with valid content (it was valid at scan time). The next
    // direct read via getMcpContent picks up the corrupted bytes.
  };

  return { catalog, catalogDir, corruptMcp };
}

/** Build an `AgentResolveResult` from a catalog plus a name. */
export function resolveTestAgent(catalog: CatalogManager, name: string): AgentResolveResult {
  return catalog.resolveAgent(name);
}

/** Re-export so callers don't need a second import. */
export type { AgentResolveResult };
