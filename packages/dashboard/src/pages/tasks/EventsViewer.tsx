import { useEffect, useRef } from "react";
import type { TaskActivity } from "../../api";
import { ActivityRow } from "./ActivityRow";

/**
 * Activity tab — runtime-neutral timeline of user / assistant /
 * summary entries. The runtime is responsible for filtering out the
 * low-signal events (handshake, model preference, system prompts);
 * what arrives here is only the things a person reads.
 *
 * Rendered as an ordered list with role-coded headers and content
 * bodies. Tool calls inside an assistant turn render as a small chip
 * row underneath the message text.
 */
export function ActivityView({
  activity,
  activityError,
  onLoadOlder,
}: {
  activity: TaskActivity | null;
  activityError: string | null;
  onLoadOlder: () => Promise<void>;
}) {
  if (activity === null) {
    if (activityError) {
      return (
        <p className="muted">
          Activity not available
          {activityError ? `: ${activityError}` : ""}.
        </p>
      );
    }
    return <p className="muted">No activity yet.</p>;
  }
  if (activity.activity.length === 0) {
    return <p className="muted">No activity yet for this task.</p>;
  }
  // Older history is available iff the oldest currently-loaded item is
  // not seq 0 (i.e. there exist seqs lower than what we have). The
  // sentinel renders ABOVE the list so when the user scrolls UP
  // towards history, intersection fires and we load the previous page.
  const oldestSeq = activity.activity[0]?.seq ?? 0;
  const hasOlder = oldestSeq > 0;
  return (
    <>
      {activity.truncated !== undefined && activity.truncated.reason === "size_limit" && (
        <div
          className="muted"
          style={{
            fontSize: 12,
            padding: "6px 10px",
            marginBottom: 8,
            background: "rgba(210, 153, 34, 0.08)",
            border: "1px solid rgba(210, 153, 34, 0.2)",
            borderRadius: 4,
          }}
        >
          Showing the tail of a very large event log
          {activity.truncated.droppedBytes !== undefined &&
            ` (${(activity.truncated.droppedBytes / (1024 * 1024)).toFixed(1)} MB dropped)`}
          . Older events were skipped to keep the page responsive.
        </div>
      )}
      {hasOlder && (
        <LoadOlderSentinel onIntersect={onLoadOlder} activity={activity} oldestSeq={oldestSeq} />
      )}
      <ol className="activity-list">
        {activity.activity.map((item) => (
          // `seq` is monotonic per task and unique within the timeline,
          // so it's a stable React key across re-renders (incl. SSE
          // updates that mutate a tool_call's status with the same seq).
          <ActivityRow key={item.seq} item={item} />
        ))}
      </ol>
    </>
  );
}

/**
 * Top-of-list sentinel that triggers the previous page fetch when
 * scrolled into view. Uses IntersectionObserver with a generous
 * rootMargin so the previous page starts loading slightly before
 * the user actually reaches the top (smoother UX than waiting for
 * the spinner to appear).
 *
 * Re-observes when `oldestSeq` changes — this fires the next
 * older-page after the current one is prepended (in case the
 * sentinel is still in view because the new page didn't fill
 * the viewport).
 */
function LoadOlderSentinel({
  onIntersect,
  activity,
  oldestSeq,
}: {
  onIntersect: () => Promise<void>;
  activity: TaskActivity;
  oldestSeq: number;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    // Reference oldestSeq in the body so the dep list isn't "extra".
    void oldestSeq;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void onIntersect();
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onIntersect, oldestSeq]);
  return (
    <div
      ref={sentinelRef}
      className="muted"
      style={{ padding: "10px 0", textAlign: "center", fontSize: 12 }}
    >
      Loading older history ({activity.activity.length} of {activity.totalItems})…
    </div>
  );
}
