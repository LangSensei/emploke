import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentResolveResult,
  CatalogManager,
  composeCatalogModule,
  type CatalogModule,
} from "@emploke/catalog";

/**
 * Build a `CatalogManager` backed by an in-memory MikroORM-managed
 * catalog DB, with optional fixtures pre-installed.
 *
 * Each fixture entry is a map of relative paths → file contents.
 * AGENTS.md / SKILL.md must be present where applicable. The helper
 * writes fixtures into a temporary "source" directory and drives
 * `catalog.installAgent` / `installSkill` / `installMcpFromOrigin`
 * to register them through the normal install path.
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
  /** Close the underlying ORM. Tests should call this in cleanup. */
  close: () => Promise<void>;
  /**
   * Test-only helper to inject garbage into an installed MCP's
   * stored spec. Bypasses validation via raw connection execute.
   */
  corruptMcp: (specName: string, content: string) => Promise<void>;
}> {
  const sourceRoot = sourceRootArg ?? (await mkdtemp(path.join(tmpdir(), "test-catalog-src-")));
  const module: CatalogModule = await composeCatalogModule({ dbFile: ":memory:" });
  const catalog = module.manager;

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
    await catalog.installSkill(`file:${dir}`);
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
    await catalog.installAgent(`file:${dir}`);
  }

  const corruptMcp = async (specName: string, content: string): Promise<void> => {
    // Bypass the catalog's validation pipeline by issuing a raw UPDATE
    // through the underlying better-sqlite3 connection. The Drizzle
    // wrapper exposes it on `.$client` for drizzle 0.45+.
    const db = (catalog as unknown as {
      mcp: {
        repo: {
          db: { $client: { prepare(sql: string): { run(...args: unknown[]): unknown } } };
        };
      };
    }).mcp.repo.db;
    db.$client.prepare("UPDATE mcps SET spec = ? WHERE fqn = ?").run(content, specName);
  };

  return {
    catalog,
    async close() {
      await module.close();
    },
    corruptMcp,
  };
}

/** Build an `AgentResolveResult` from a catalog plus a name. */
export function resolveTestAgent(
  catalog: CatalogManager,
  name: string,
): Promise<AgentResolveResult> {
  return catalog.resolveAgent(name);
}

export type { AgentResolveResult };
