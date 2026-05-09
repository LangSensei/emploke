import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdirP, writeJsonAtomic } from "@emploke/fs";
import { FrontmatterError } from "../errors.js";
import {
  type CatalogConfig,
  CATALOG_CONFIG_VERSION,
  type CatalogRepository,
} from "./catalog-repository.js";

const CATALOG_JSON_FILENAME = "catalog.json";

/**
 * Filesystem-backed `CatalogRepository`.
 *
 * Layout:
 *   `<catalogDir>/catalog.json`
 *
 * `read()` returns `null` when the file is missing — the catalog layer
 * synthesises a v1 stub on first install. Atomic writes via tmp+rename
 * (see {@link writeJsonAtomic}); concurrent readers never see partial
 * JSON.
 *
 * Validation is shallow: parse the JSON, type-check the shape, fail
 * with {@link FrontmatterError} on malformed input. Version-compat
 * (refuse unknown versions) lives one layer up so the version-bump
 * surface is centralized at the catalog manager.
 */
export class FsCatalogRepository implements CatalogRepository {
  private readonly path: string;

  constructor(catalogDir: string) {
    this.path = join(catalogDir, CATALOG_JSON_FILENAME);
  }

  async read(): Promise<CatalogConfig | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new FrontmatterError(this.path, `catalog.json is not valid JSON: ${(cause as Error).message}`, {
        cause,
      });
    }
    return parseCatalogConfig(parsed, this.path);
  }

  async write(config: CatalogConfig): Promise<void> {
    await mkdirP(join(this.path, ".."));
    await writeJsonAtomic(this.path, config);
  }
}

/**
 * Validate the parsed JSON shape of `catalog.json`. Returns the typed
 * record. Throws {@link FrontmatterError} on shape violations so the
 * route layer maps it to 400 / surfaces a useful message.
 *
 * Exported so the in-memory repository (used by tests) can share the
 * same validation pass.
 */
export function parseCatalogConfig(parsed: unknown, sourcePath: string): CatalogConfig {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FrontmatterError(sourcePath, "catalog.json must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj.version;
  if (version !== CATALOG_CONFIG_VERSION) {
    throw new FrontmatterError(
      sourcePath,
      `unsupported catalog.json version ${JSON.stringify(version)}; expected ${CATALOG_CONFIG_VERSION}`,
    );
  }
  const rawMappings = obj.scopeMappings ?? {};
  if (rawMappings === null || typeof rawMappings !== "object" || Array.isArray(rawMappings)) {
    throw new FrontmatterError(sourcePath, "`scopeMappings` must be a JSON object");
  }
  const mappings: Record<string, string> = {};
  for (const [pattern, scope] of Object.entries(rawMappings as Record<string, unknown>)) {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new FrontmatterError(sourcePath, "scopeMapping patterns must be non-empty strings");
    }
    if (typeof scope !== "string" || scope.length === 0) {
      throw new FrontmatterError(
        sourcePath,
        `scopeMapping for "${pattern}" must be a non-empty string`,
      );
    }
    mappings[pattern] = scope;
  }
  return { version: CATALOG_CONFIG_VERSION, scopeMappings: mappings };
}
