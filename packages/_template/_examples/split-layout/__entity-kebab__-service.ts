// EXAMPLE FILE — not built. See _examples/split-layout/README.md.
//
// Illustrative facade for the "split a service that outgrew the 600 LOC / 3-concern
// thresholds" recipe. Mirrors `packages/task/src/task-service.ts` in shape: build a
// `__Entity__ServiceCtx` once in the constructor, then each public method is a single
// `return delegate(this.ctx, …args)` line. Stays well under the 250 LOC facade ceiling
// from `docs/pkg-template.md § Hard rules` rule #6.

import {
  initialize__Entity__Service,
  shutdown__Entity__Service,
} from "./__entity-kebab__-service/lifecycle.js";
import { create__Entity__, delete__Entity__ } from "./__entity-kebab__-service/mutations.js";
import { get__Entity__, list__Entity__ } from "./__entity-kebab__-service/queries.js";
import type {
  __Entity__,
  __Entity__ServiceConfig,
  __Entity__ServiceCtx,
  Create__Entity__Args,
  List__Entity__Opts,
} from "./__entity-kebab__-service/types.js";

/**
 * Public surface for the `__PKG__` package's `__Entity__` BC.
 *
 * Reads + writes live here, behind a single class. Internally, each public method
 * delegates to a peer function in `./__entity-kebab__-service/` (queries / mutations
 * / lifecycle), threading the shared `__Entity__ServiceCtx` so concerns can share
 * state (the repository handle, the clock, the logger) without `this`-casting or
 * widening field visibility.
 *
 * The subdir is package-private — never re-exported from `./index.ts`. Downstream
 * callers depend on the facade only.
 */
export class __Entity__Service {
  private readonly ctx: __Entity__ServiceCtx;

  constructor(config: __Entity__ServiceConfig) {
    // TODO: replace this ctx with whatever your concerns actually need.
    // Common shape: a repository handle + the clock seam + a logger + any
    // long-lived in-memory state (e.g. live subprocess registries).
    this.ctx = {
      repository: config.repository,
      logger: config.logger,
      now: config.now ?? (() => new Date()),
    };
  }

  async list(opts: List__Entity__Opts = {}): Promise<__Entity__[]> {
    return list__Entity__(this.ctx, opts);
  }

  async get(id: string): Promise<__Entity__ | null> {
    return get__Entity__(this.ctx, id);
  }

  async create(args: Create__Entity__Args): Promise<__Entity__> {
    return create__Entity__(this.ctx, args);
  }

  async delete(id: string): Promise<void> {
    return delete__Entity__(this.ctx, id);
  }

  async initialize(): Promise<void> {
    return initialize__Entity__Service(this.ctx);
  }

  async shutdown(): Promise<void> {
    return shutdown__Entity__Service(this.ctx);
  }
}
