import { NotificationData } from "mediatr-ts";

/**
 * Marker base for every workspace-pkg domain event.
 *
 * Extends mediatr-ts's `NotificationData` so events go through
 * `mediator.publish(...)` — same dispatch path Phase 3+ will use for
 * cross-context integration events. Phase 1 has zero notification
 * handlers (workspace is the root context with no upstream
 * subscribers); raising events here proves the publish path works
 * end-to-end without forcing premature subscribers.
 */
export abstract class WorkspaceDomainEvent extends NotificationData {
  /** ISO-8601 UTC timestamp when the aggregate raised this event. */
  abstract readonly occurredAt: string;
}
