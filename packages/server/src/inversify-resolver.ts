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
 * **`add` is idempotent**. `composeXxxModule` typically pre-binds
 * handler classes `toSelf()` and *also* calls
 * `mediator.registerHandler(Cmd, HandlerClass)` — and mediatr-ts's
 * `registerHandler` internally calls `resolver.add(HandlerClass)` to
 * make sure the handler is resolvable. Without the idempotent guard,
 * the same class ends up bound twice and inversify v7 throws
 * "Ambiguous bindings found" the next time the mediator tries to
 * dispatch. `isBound` + skip is the cheapest fix; it also makes
 * compose-modules safe to call repeatedly (which tests do).
 *
 * NOTE: byte-identical to `@emploke/cli`'s `InversifyResolver`. The
 * duplication is intentional through Phase 1 to keep the two
 * composition roots in lock-step. If both bridges still match after
 * Phase 2+ binding work lands, extract to a tiny shared internal
 * module.
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
