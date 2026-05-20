import type { Container } from "inversify";
import type { Class, Resolver } from "mediatr-ts";

/**
 * Bridges mediatr-ts handler resolution to the inversify container.
 *
 * Mirrors `@emploke/server`'s `InversifyResolver`. Phase 0 keeps the
 * two composition roots in lock-step; if their bindings ever diverge
 * (issue #135 leaves that door open for Phase 1+), the bridges can
 * still be the same — they only know about `Container.get` /
 * `Container.bind`.
 */
export class InversifyResolver implements Resolver {
  constructor(private readonly container: Container) {}

  resolve<T>(type: Class<T>): T {
    return this.container.get(type);
  }

  add<T>(type: Class<T>): void {
    this.container.bind(type).toSelf();
  }
}
