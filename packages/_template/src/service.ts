import { randomBytes } from "node:crypto";
import { __Entity__NotFoundError } from "./errors.js";
import type { __Entity__Repository } from "./repository.js";
import type { __Entity__Row } from "./schema.js";
import type { __Entity__, Create__Entity__Args } from "./types.js";

/**
 * Write surface for `@emploke/__PKG__`. ALL create / update / delete
 * methods live here. Returns wire-shape DTOs so callers don't need a
 * follow-up read.
 *
 * NEVER add read-only methods here — those belong on
 * `__Entity__Queries`. The split makes it trivial for downstream
 * packages to declare "I only read this BC" via the queries type.
 */
export class __Entity__Service {
  constructor(
    private readonly repo: __Entity__Repository,
    private readonly opts: { readonly now?: () => Date } = {},
  ) {}

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
