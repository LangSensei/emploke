import { useEffect, useId, useRef, useState } from "react";
import type { ActivityItem, TaskActivity } from "../../api";
import { formatAbsolute, formatRelative } from "../../utils/time";

/**
 * Activity view + supporting row renderers extracted verbatim from
 * the original `pages/Tasks.tsx`. Runtime-neutral timeline of user /
 * assistant / summary / thinking / tool_call / system entries.
 *
 * Used by the Activity tab (full live-tailing activity stream).
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
          <ActivityRow key={item.seq} item={item} />
        ))}
      </ol>
    </>
  );
}

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

export function ActivityRow({ item }: { item: ActivityItem }) {
  if (item.kind === "summary") {
    const stats = item.stats;
    const tokens = item.tokens;
    const codeChanged =
      stats !== undefined &&
      ((stats.linesAdded ?? 0) > 0 ||
        (stats.linesRemoved ?? 0) > 0 ||
        (stats.filesModified?.length ?? 0) > 0);
    return (
      <li className="activity-row activity-row--summary">
        <div className="activity-row__head">
          <span className="activity-row__role activity-row__role--summary">Summary</span>
          <time className="activity-row__time" title={formatAbsolute(item.timestamp)}>
            {formatRelative(item.timestamp)}
          </time>
        </div>
        {item.text !== undefined && item.text.length > 0 && (
          <p className="activity-row__body">{item.text}</p>
        )}
        <div className="activity-row__summary-grid">
          {codeChanged ? (
            <span>
              <strong>Code:</strong> +{stats?.linesAdded ?? 0} −{stats?.linesRemoved ?? 0} across{" "}
              {stats?.filesModified?.length ?? 0} file
              {(stats?.filesModified?.length ?? 0) === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="muted">No code changes</span>
          )}
          {(stats?.premiumRequests ?? 0) > 0 && (
            <span>
              <strong>Premium requests:</strong> {stats?.premiumRequests}
            </span>
          )}
          {tokens !== undefined && ((tokens.input ?? 0) > 0 || tokens.output > 0) && (
            <span>
              <strong>Tokens:</strong>{" "}
              {tokens.input !== undefined ? (
                <>
                  {tokens.input.toLocaleString()} in
                  {tokens.cached !== undefined && tokens.input > 0 && (
                    <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>
                      ({Math.round((tokens.cached / tokens.input) * 100)}% cached)
                    </span>
                  )}
                  {" / "}
                </>
              ) : null}
              {tokens.output.toLocaleString()} out
              {tokens.reasoning !== undefined && tokens.reasoning > 0 && (
                <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>
                  (incl. {tokens.reasoning.toLocaleString()} reasoning)
                </span>
              )}
            </span>
          )}
          {stats?.costUSD !== undefined && (
            <span>
              <strong>Cost:</strong> ${stats.costUSD.toFixed(4)}
            </span>
          )}
          {stats?.model && (
            <span>
              <strong>Model:</strong> {stats.model}
            </span>
          )}
        </div>
      </li>
    );
  }

  if (item.kind === "thinking") {
    return (
      <li className="activity-row activity-row--thinking">
        <div className="activity-row__head">
          <span className="activity-row__role activity-row__role--thinking">
            Thinking{item.subject ? `: ${item.subject}` : ""}
          </span>
          <time className="activity-row__time" title={formatAbsolute(item.timestamp)}>
            {formatRelative(item.timestamp)}
          </time>
        </div>
        <details open>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
            Reasoning
          </summary>
          <p className="activity-row__body" style={{ fontStyle: "italic", opacity: 0.8 }}>
            {item.text}
          </p>
        </details>
      </li>
    );
  }

  if (item.kind === "tool_call") {
    const statusColor =
      item.status === "success"
        ? "#3fb950"
        : item.status === "error"
          ? "#f85149"
          : item.status === "cancelled"
            ? "#8b949e"
            : "#d29922";
    return (
      <li className="activity-row activity-row--tool_call">
        <div className="activity-row__head">
          <span className="activity-row__role activity-row__role--tool_call">
            <span style={{ color: statusColor }}>●</span> tool: {item.name}
          </span>
          <time className="activity-row__time" title={formatAbsolute(item.timestamp)}>
            {formatRelative(item.timestamp)}
            {item.durationMs !== undefined && ` (${item.durationMs}ms)`}
          </time>
        </div>
        {item.args !== undefined && (
          <details>
            <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
              Arguments
            </summary>
            <pre className="activity-row__pre">{JSON.stringify(item.args, null, 2)}</pre>
          </details>
        )}
        {item.display !== undefined ? (
          <ToolDisplay content={item.display.content} />
        ) : (
          item.result !== undefined && (
            <details>
              <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
                Result
              </summary>
              <pre className="activity-row__pre">
                {typeof item.result === "string"
                  ? item.result
                  : JSON.stringify(item.result, null, 2)}
              </pre>
            </details>
          )
        )}
      </li>
    );
  }

  if (item.kind === "system") {
    const levelColor =
      item.level === "error" ? "#f85149" : item.level === "warn" ? "#d29922" : "#8b949e";
    return (
      <li className="activity-row activity-row--system">
        <div className="activity-row__head">
          <span className="activity-row__role activity-row__role--system">
            <span style={{ color: levelColor }}>●</span> {item.subKind ?? "system"}
          </span>
          <time className="activity-row__time" title={formatAbsolute(item.timestamp)}>
            {formatRelative(item.timestamp)}
          </time>
        </div>
        <p className="activity-row__body muted" style={{ fontSize: 12 }}>
          {item.text}
        </p>
      </li>
    );
  }

  // user / assistant
  return (
    <li className={`activity-row activity-row--${item.kind}`}>
      <div className="activity-row__head">
        <span className={`activity-row__role activity-row__role--${item.kind}`}>
          {item.kind === "user" ? "User" : "Assistant"}
          {item.kind === "assistant" && item.model !== undefined && (
            <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
              ({item.model})
            </span>
          )}
        </span>
        <time className="activity-row__time" title={formatAbsolute(item.timestamp)}>
          {formatRelative(item.timestamp)}
          {item.kind === "assistant" && item.tokens !== undefined && (
            <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
              ({item.tokens.output.toLocaleString()} tok)
            </span>
          )}
        </time>
      </div>
      {item.text.length > 0 && <p className="activity-row__body">{item.text}</p>}
      {item.kind === "user" && item.attachments !== undefined && item.attachments.length > 0 && (
        <div
          className="activity-row__attachments"
          style={{ display: "flex", gap: 6, marginTop: 4 }}
        >
          {item.attachments.map((att) => (
            <span
              key={att.url ?? att.data ?? att.name ?? Math.random()}
              className="activity-row__tool"
              title={att.mimeType ?? att.kind}
            >
              📎 {att.name ?? att.kind}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

const TOOL_DISPLAY_PREVIEW_CHARS = 240;
function ToolDisplay({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const isLong = content.length > TOOL_DISPLAY_PREVIEW_CHARS;
  if (!isLong) {
    return (
      <p className="activity-row__body" style={{ fontSize: 12 }}>
        {content}
      </p>
    );
  }
  const previewSrc = content.split("\n", 1)[0] ?? content;
  const preview =
    previewSrc.length > TOOL_DISPLAY_PREVIEW_CHARS
      ? `${previewSrc.slice(0, TOOL_DISPLAY_PREVIEW_CHARS)}…`
      : previewSrc;
  return (
    <div>
      {expanded ? (
        <pre id={bodyId} className="activity-row__pre">
          {content}
        </pre>
      ) : (
        <p id={bodyId} className="activity-row__body" style={{ fontSize: 12 }}>
          {preview}
        </p>
      )}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        style={{
          marginTop: 4,
          background: "none",
          border: "none",
          color: "var(--color-link, #58a6ff)",
          cursor: "pointer",
          padding: 0,
          fontSize: 11,
        }}
      >
        {expanded ? "Show less" : `Show full (${content.length.toLocaleString()} chars)`}
      </button>
    </div>
  );
}
