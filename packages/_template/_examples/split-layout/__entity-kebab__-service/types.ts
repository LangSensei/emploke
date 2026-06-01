// EXAMPLE FILE — not built. See _examples/split-layout/README.md.
//
// Shared types passed across concern files via the ctx object. Defining the ctx
// shape (and the public DTOs it produces / accepts) in this peer module lets every
// concern file `import type { __Entity__ServiceCtx } from "./types.js"` without
// reaching back into the facade — which would create a circular import once the
// facade also imports each concern.
//
// Real packages may choose to define the ctx interface on the facade module instead
// (see `packages/task/src/task-service.ts` for that variant). Either placement is
// fine; pick one and use it consistently inside the split.

import type { Logger } from "pino";

/**
 * Wire-shape DTO. Same as what the package's public `types.ts` would export.
 * Reproduced inside the split's `types.ts` here ONLY because this example is
 * self-contained; in a real package, import the DTO from the package's public
 * `types.ts` instead of redefining it.
 */
export interface __Entity__ {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface Create__Entity__Args {
  readonly name: string;
}

export interface List__Entity__Opts {
  readonly limit?: number;
  readonly status?: "active" | "archived";
}

/**
 * Minimal repository contract the concerns rely on. In a real package this
 * lives in `<entity>-repository.ts` and the ctx just holds an instance of
 * `__Entity__Repository`; the inline interface here keeps the example
 * self-contained.
 */
export interface __Entity__Repository {
  list(opts: List__Entity__Opts): Promise<__Entity__[]>;
  findById(id: string): Promise<__Entity__ | undefined>;
  insert(row: __Entity__): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * Constructor argument shape. Wraps everything the facade needs to build the
 * ctx. Optional fields default in the facade constructor.
 */
export interface __Entity__ServiceConfig {
  readonly repository: __Entity__Repository;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/**
 * Shared state the facade builds once and passes to every concern function.
 *
 * `readonly` markers reflect identity-stability (the repository handle, the
 * logger are never reassigned). Add mutable fields here when concerns must
 * coordinate cross-cutting state (e.g. a `Map<string, LiveSubprocess>` that
 * `mutations.ts` writes and `queries.ts` reads). Compare with
 * `packages/task/src/task-service.ts`'s `TaskServiceCtx` for a real example
 * that includes mutable coordination state.
 */
export interface __Entity__ServiceCtx {
  readonly repository: __Entity__Repository;
  readonly logger: Logger;
  readonly now: () => Date;
}
