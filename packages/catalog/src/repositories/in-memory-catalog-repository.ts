import {
  type CatalogConfig,
  CATALOG_CONFIG_VERSION,
  type CatalogRepository,
} from "./catalog-repository.js";

/**
 * In-memory `CatalogRepository` for tests. State persists for the
 * lifetime of the instance; reads return a deep-cloned snapshot so
 * callers can't mutate the stored value through the returned reference.
 */
export class InMemoryCatalogRepository implements CatalogRepository {
  private snapshot: CatalogConfig | null = null;

  async read(): Promise<CatalogConfig | null> {
    if (this.snapshot === null) return null;
    return {
      version: this.snapshot.version,
      scopeMappings: { ...this.snapshot.scopeMappings },
    };
  }

  async write(config: CatalogConfig): Promise<void> {
    this.snapshot = {
      version: CATALOG_CONFIG_VERSION,
      scopeMappings: { ...config.scopeMappings },
    };
  }
}
