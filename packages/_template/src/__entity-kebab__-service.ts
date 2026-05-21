import { randomBytes } from "node:crypto";
import type { __Entity__Repository } from "./__entity-kebab__-repository.js";
import { __Entity__NotFoundError } from "./errors.js";
import type { __Entity__Row } from "./schema.js";
import type { __Entity__, Create__Entity__Args, List__Entity__Opts } from "./types.js";

/**
 * Public surface for `@emploke/__PKG__`. Holds both reads (list / get /
 * lookup) and writes (create / update / delete). All methods return
 * wire-shape DTOs (`__Entity__`), never internal row types.
 *
 * One class per BC — there is no Queries/Service split. Industry
 * convention (NestJS, tRPC, codex, Plane) shows a single service is
 * sufficient at this scale; the split adds indirection without a
 * payoff.
 */
export class __Entity__Service {
  constructor(
    private readonly repo: __Entity__Repository,
    private readonly opts: { readonly now?: () => Date } = {},
  ) {}

  // ─── Reads ─────────────────────────────────────────────

  async get(id: string): Promise<__Entity__ | null> {
    const row = await this.repo.read(id);
    return row !== undefined ? rowTo__Entity__(row) : null;
  }

  async list(opts: List__Entity__Opts = {}): Promise<__Entity__[]> {
    const rows = await this.repo.list(opts);
    return rows.map(rowTo__Entity__);
  }

  // ─── Writes ────────────────────────────────────────────

  async create(args: Create__Entity__Args): Promise<__Entity__> {
    const now = (this.opts.now ?? (() => new Date()))().toISOString();
    const id = randomBytes(8).toString("hex");
    const row: __Entity__Row = { id, name: args.name, createdAt: now };
    await this.repo.insert(row);
    return { id, name: args.name, createdAt: now };
  }

  async delete(id: string): Promise<void> {
    const existing = await this.repo.read(id);
    if (existing === undefined) throw new __Entity__NotFoundError(id);
    await this.repo.delete(id);
  }
}

function rowTo__Entity__(row: __Entity__Row): __Entity__ {
  return { id: row.id, name: row.name, createdAt: row.createdAt };
}
