import type { __Entity__Repository } from "./repository.js";
import type { __Entity__Row } from "./schema.js";
import type { List__Entity__Opts, __Entity__ } from "./types.js";

/**
 * Read surface for `@emploke/__PKG__`. ALL list / get / lookup methods
 * live here. Returns wire-shape DTOs (`__Entity__`), never internal
 * row types.
 *
 * Downstream packages should declare their dependency on
 * `__Entity__Queries` (or a narrower capability interface), not on
 * the concrete `__Entity__Service`.
 */
export class __Entity__Queries {
  constructor(private readonly repo: __Entity__Repository) {}

  async get(id: string): Promise<__Entity__ | null> {
    const row = await this.repo.read(id);
    return row !== undefined ? rowTo__Entity__(row) : null;
  }

  async list(opts: List__Entity__Opts = {}): Promise<__Entity__[]> {
    const rows = await this.repo.list(opts);
    return rows.map(rowTo__Entity__);
  }
}

function rowTo__Entity__(row: __Entity__Row): __Entity__ {
  return { id: row.id, name: row.name, createdAt: row.createdAt };
}
