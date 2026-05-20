import type { Container } from "inversify";
import type { Class, Resolver } from "mediatr-ts";

/**
 * Bridges mediatr-ts handler resolution to the inversify container.
 *
 * Per the mediatr-ts README's "Integrating with Dependency Injection
 * containers" section, the library accepts a custom `Resolver` so
 * handlers can be resolved from whichever DI library the host process
 * already uses. Inversify is our choice (see issue #135 ADR), so we
 * forward `resolve` to `container.get` and `add` to
 * `container.bind(type).toSelf()`.
 *
 * Phase 0: no handlers are registered yet, so neither method is
 * exercised at runtime; the bridge exists so that `new Mediator({
 * resolver })` has a non-default resolver wired from day one and
 * `mediator.registerHandler(...)` calls in subsequent phases land on
 * the inversify container without further plumbing.
 *
 * NOTE: byte-identical to `@emploke/cli`'s `InversifyResolver`. The
 * duplication is intentional through Phase 0 to keep the two
 * composition roots in lock-step. If both bridges still match after
 * Phase 1+ binding work lands, extract to a tiny shared internal
 * module.
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
