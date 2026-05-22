import { randomBytes } from "node:crypto";
import type { __Entity__Repository } from "./__entity-kebab__-repository.js";
import { __Entity__NotFoundError } from "./errors.js";
import type { __Entity__Row } from "./schema.js";
import type { __Entity__, Create__Entity__Args, List__Entity__Opts } from "./types.js";

/**
 * Public surface for `@emploke/__PKG__`. Holds both reads (list / get /
 * lookup) and writes (create / update / delete). All methods return
 * wire-shape DTOs (`__Entity__`).
 *
 * One class per BC — there is no Queries/Service split. Industry
 * convention (NestJS, tRPC, codex, Plane) shows a single service is
 * sufficient at this scale; the split adds indirection without a
 * payoff.
 *
 * The service is a thin orchestrator on top of `__Entity__Repository`.
 * The repository owns the persistence ↔ DTO projection (`rowToDto`
 * inside `__entity-kebab__-repository.ts`); the service contributes
 * write-side validation, id minting, and any cross-pkg coordination
 * (e.g. a runtime hook, a layout helper).
 */
export class __Entity__Service {
  constructor(
    private readonly repo: __Entity__Repository,
    private readonly opts: { readonly now?: () => Date } = {},
  ) {}

  // ─── Reads ─────────────────────────────────────────────

  async get(id: string): Promise<__Entity__ | null> {
    return (await this.repo.findById(id)) ?? null;
  }

  async list(opts: List__Entity__Opts = {}): Promise<__Entity__[]> {
    return this.repo.list(opts);
  }

  // ─── Writes ────────────────────────────────────────────

  async create(args: Create__Entity__Args): Promise<__Entity__> {
    const now = (this.opts.now ?? (() => new Date()))().toISOString();
    const id = randomBytes(8).toString("hex");
    // `insert` takes a row-shaped value because we already know every
    // column; the repository is the only legitimate place a `*Row`
    // value is mentioned outside the schema module.
    const row: __Entity__Row = { id, name: args.name, createdAt: now };
    await this.repo.insert(row);
    return { id, name: args.name, createdAt: now };
  }

  async delete(id: string): Promise<void> {
    const existing = await this.repo.findById(id);
    if (existing === undefined) throw new __Entity__NotFoundError(id);
    await this.repo.delete(id);
  }
}
