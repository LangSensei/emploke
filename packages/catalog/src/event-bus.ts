import type { EventBus } from "./types.js";

/**
 * Synchronous in-process event bus.
 *
 * Handlers are invoked synchronously in subscription order. A throwing handler
 * is isolated: it does not prevent later handlers from running and does not
 * propagate to the publisher. emploke deliberately swallows handler errors
 * because publishing is a side-effect; callers that need error visibility
 * should handle errors inside their own subscribe callback.
 */
export class InMemoryEventBus<E> implements EventBus<E> {
  private readonly handlers = new Set<(event: E) => void>();

  publish(event: E): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // intentionally swallowed; see class doc
      }
    }
  }

  subscribe(handler: (event: E) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Internal helper for tests. */
  get size(): number {
    return this.handlers.size;
  }
}
