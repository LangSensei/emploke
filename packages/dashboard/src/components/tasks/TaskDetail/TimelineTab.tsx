import type { TaskActivity, TaskRecord } from "../../../api";
import { formatAbsolute, formatRelative } from "../../../utils/time";

export interface TimelineTabProps {
  task: TaskRecord;
  activity: TaskActivity | null;
}

/**
 * Timeline tab — a sparse, body-less list of activity items.
 *
 * Each row shows just `kind + seq + timestamp` (no text body) so the
 * user can see the *shape* of the run at a glance. Per the mission-A
 * spec, when activity isn't available we fall back to a 3-stop
 * minimal timeline derived from the lifecycle timestamps
 * (`createdAt → startedAt → endedAt`).
 */
export function TimelineTab({ task, activity }: TimelineTabProps) {
  const items = activity?.activity ?? [];
  if (items.length > 0) {
    return (
      <div className="task-detail__body">
        <ol className="timeline">
          {items.map((it) => (
            <li key={it.seq} className="timeline__row">
              <span className={`timeline__dot timeline__dot--${it.kind}`} aria-hidden="true" />
              <span className="timeline__kind">{it.kind}</span>
              <span className="timeline__seq muted">#{it.seq}</span>
              <time className="timeline__time muted" title={formatAbsolute(it.timestamp)}>
                {formatRelative(it.timestamp)}
              </time>
            </li>
          ))}
        </ol>
      </div>
    );
  }
  // Lifecycle fallback when activity isn't available.
  const stops: { label: string; ts: string }[] = [];
  if (task.createdAt) stops.push({ label: "Created", ts: task.createdAt });
  if (task.startedAt && task.startedAt !== task.createdAt) {
    stops.push({ label: "Started", ts: task.startedAt });
  }
  if (task.endedAt) stops.push({ label: "Ended", ts: task.endedAt });
  return (
    <div className="task-detail__body">
      <ol className="timeline">
        {stops.map((s) => (
          <li key={s.label} className="timeline__row">
            <span className="timeline__dot" aria-hidden="true" />
            <span className="timeline__kind">{s.label}</span>
            <time className="timeline__time muted" title={formatAbsolute(s.ts)}>
              {formatRelative(s.ts)}
            </time>
          </li>
        ))}
      </ol>
    </div>
  );
}
