import type { Container } from "inversify";
import type { Class, Resolver } from "mediatr-ts";

/**
 * Bridges mediatr-ts handler resolution to the inversify container.
 *
 * Mirrors `@emploke/server`'s `InversifyResolver`. Phase 1 keeps the
 * two composition roots in lock-step; if their bindings ever diverge
 * the bridges can still be the same — they only know about
 * `Container.get` / `Container.bind` / `Container.isBound`.
 *
 * **`add` is idempotent**: see the matching comment on the server's
 * resolver for why this guard is needed (composeXxxModule pre-binds
 * handlers, then mediatr-ts's `registerHandler` calls `add` again).
 */
export class InversifyResolver implements Resolver {
  constructor(private readonly container: Container) {}

  resolve<T>(type: Class<T>): T {
    return this.container.get(type);
  }

  add<T>(type: Class<T>): void {
    if (this.container.isBound(type)) return;
    this.container.bind(type).toSelf();
  }
}
