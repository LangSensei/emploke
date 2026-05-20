import type { Mediator } from "mediatr-ts";
import type { WorkspaceDomainEvent } from "./events/domain-event.js";

/**
 * Publish a workspace domain event, swallowing the "no subscribers"
 * error that mediatr-ts surfaces when `typeMappings.notifications` has
 * no entry for the event class.
 *
 * Phase 1 of issue #135 has zero notification handlers — workspace is
 * the root context with no cross-context reactions, and forcing a
 * dummy subscriber to keep the dispatch path quiet would muddy the
 * production wiring. Instead we treat the "no handler" case as a
 * **successful no-op**: the aggregate raised the event, the handler
 * attempted dispatch, and once a future phase wires in a real
 * subscriber the swallow is automatically replaced by real
 * processing (mediatr-ts no longer throws once `getAll` finds at
 * least one entry).
 *
 * Any other error from `mediator.publish` (handler threw, etc.) is
 * re-thrown so the command rolls back as expected.
 */
export async function publishWorkspaceEvent(
  mediator: Mediator,
  event: WorkspaceDomainEvent,
): Promise<void> {
  try {
    await mediator.publish(event);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("No handler found for notification ")) {
      return;
    }
    throw err;
  }
}
